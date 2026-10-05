import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { npmEnv } from "./acquire.ts";
import { hasSecret } from "./keychain.ts";
import { ask, askSecret, choose, chooseMany, confirm, log, spinner } from "./prompt.ts";
import { DEFAULT_LINKS, LINK_TARGETS, type InstallerSet, type NpmSet, type Registry, type SkillSet, type SkillsCliSet } from "./registry.ts";

// `skl register`: add a set to the registry by answering questions, or from
// `--json` for scripts and agents. Either way the entry is validated before
// it is written.

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Split a command line the way a shell would for plain words and quotes. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in command.");
  if (started) out.push(cur);
  return out;
}

const list = (line: string) => line.split(",").map((s) => s.trim()).filter(Boolean);

/** Problems with an entry; empty when it can be written. */
export function validateSet(id: string, set: SkillSet, reg: Registry): string[] {
  const problems: string[] = [];
  if (!ID_RE.test(id)) problems.push(`set id "${id}" must use a-z, 0-9 and single hyphens`);
  if (reg.sets[id]) problems.push(`set "${id}" already exists`);
  const isWords = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (set.links !== undefined && !(isWords(set.links) && set.links.every((l) => l in LINK_TARGETS))) {
    problems.push(`links must be a list of: ${Object.keys(LINK_TARGETS).join(", ")}`);
  }
  switch (set.type) {
    case "installer":
      if (!isWords(set.command) || set.command.length === 0) problems.push("command must be a non-empty list of words");
      if (set.unattended !== undefined && !isWords(set.unattended)) problems.push("unattended must be a list of words");
      if (set.secret !== undefined && set.secret !== "keychain") problems.push('secret must be "keychain"');
      if (set.secret === "keychain" && !set.command?.some((a) => a.includes("{secret}"))) {
        problems.push("secret is set but no command word contains {secret}");
      }
      if (set.command?.some((a) => /--token=(?!\{secret\})\S/.test(a))) {
        problems.push("command contains a literal token; use {secret} and store it with skl secret");
      }
      break;
    case "npm":
      if (!/^(@[^/@]+\/)?[^/@]+@\d[^@]*$/.test(set.package ?? "")) problems.push("package must be pinned, e.g. motion-ai@14.1.0");
      if (!set.path || set.path.includes("..")) problems.push("path must be a folder inside the package");
      break;
    case "skills-cli":
      if (!/^[\w.-]+\/[\w.-]+$/.test(set.source ?? "")) problems.push("source must be owner/repo");
      break;
    default:
      problems.push('type must be "installer", "npm" or "skills-cli"');
  }
  return problems;
}

const SECRET_FLAG = /^(--?(?:token|api-key|apikey|key|secret|auth))(=)(.+)$/i;

/**
 * Pull a pasted token out of a command: `--token=abc` becomes
 * `--token={secret}` and `abc` is returned for Keychain. Handles the
 * `--token abc` form too.
 */
export function extractSecret(argv: string[]): { command: string[]; secret?: string } {
  const command = [...argv];
  for (let i = 0; i < command.length; i++) {
    const m = SECRET_FLAG.exec(command[i]);
    if (m && m[3] !== "{secret}") {
      command[i] = `${m[1]}={secret}`;
      return { command, secret: m[3] };
    }
    const bare = /^--?(?:token|api-key|apikey|key|secret|auth)$/i.test(command[i]);
    if (bare && command[i + 1] && !command[i + 1].startsWith("-") && command[i + 1] !== "{secret}") {
      const secret = command[i + 1];
      command.splice(i, 2, `${command[i]}={secret}`);
      return { command, secret };
    }
  }
  return { command };
}

/** Index of the package an `npx`/`pnpm dlx`/`bunx` command runs, or -1. */
export function packageIndex(argv: string[]): number {
  const runners = new Set(["npx", "bunx", "dlx", "pnpx"]);
  const at = argv.findIndex((a) => runners.has(a));
  if (at < 0) return -1;
  return argv.findIndex((a, i) => i > at && !a.startsWith("-"));
}

export function isPinned(spec: string): boolean {
  return /^(@[^/@]+\/)?[^/@]+@\d/.test(spec);
}

const bareName = (spec: string) => spec.replace(/^(@?[^@]+)@.*$/, "$1");

function latest(name: string): string | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-view-"));
  try {
    const r = spawnSync("npm", ["view", name, "version"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, ...npmEnv(tmp) },
    });
    return r.status === 0 ? r.stdout.trim() : null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Folders inside an npm package that hold skill folders, most skills first. */
function skillRootsIn(spec: string): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-pack-"));
  try {
    const env = { ...process.env, ...npmEnv(tmp) };
    const pack = spawnSync("npm", ["pack", spec, "--silent", "--pack-destination", tmp], { cwd: tmp, encoding: "utf8", env });
    if (pack.status !== 0) return [];
    spawnSync("tar", ["xzf", path.join(tmp, pack.stdout.trim().split("\n").at(-1)!), "-C", tmp]);
    const pkg = path.join(tmp, "package");
    const counts = new Map<string, number>();
    for (const e of fs.readdirSync(pkg, { withFileTypes: true, recursive: true })) {
      if (!e.isFile() || e.name !== "SKILL.md") continue;
      const root = path.relative(pkg, path.dirname(e.parentPath)) || ".";
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([root, n]) => `${root}|${n}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Pin `spec` to its latest version, asking first. Returns the spec to use. */
async function offerPin(spec: string): Promise<string> {
  if (isPinned(spec)) return spec;
  const s = spinner();
  s.start(`Looking up the latest ${bareName(spec)}`);
  const version = latest(bareName(spec));
  s.stop(version ? `${bareName(spec)}@${version} is the latest` : `Could not look up ${bareName(spec)}`);
  if (version && (await confirm(`Pin to ${bareName(spec)}@${version}? Upgrades then stay your decision.`))) {
    return `${bareName(spec)}@${version}`;
  }
  return spec;
}

export interface WizardResult {
  set: SkillSet;
  /** A token pasted into the command, to store in Keychain. */
  secret?: string;
}

/**
 * Run `<command> --help` in a throwaway HOME (token words dropped) and pick
 * out a flag that usually means "don't ask": -y, --yes, --non-interactive,
 * --no-input. A suggestion only; you confirm it.
 */
export function suggestUnattendedFlag(helpText: string): string | null {
  for (const flag of ["--yes", "-y", "--non-interactive", "--no-input"]) {
    if (new RegExp(`(^|[\\s,(])${flag.replace(/-/g, "\\-")}(?=[\\s,)=]|$)`, "m").test(helpText)) {
      return flag === "--yes" && /(^|[\s,(])-y(?=[\s,)]|$)/m.test(helpText) ? "-y" : flag;
    }
  }
  return null;
}

function readHelp(command: string[]): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-help-"));
  try {
    const argv = [...command.filter((a) => !a.includes("{secret}")), "--help"];
    const r = spawnSync(argv[0], argv.slice(1), {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, HOME: tmp, ...npmEnv(tmp) },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const SCOPE_FLAG = /^--?(global|user|g)$/;

async function askLinks(): Promise<string[] | undefined> {
  const links = await chooseMany(
    "Which agents should get these skills? (space to toggle, enter to confirm)",
    Object.entries(LINK_TARGETS).map(([value, t]) => ({ value, label: t.label, hint: "symlink" })),
    DEFAULT_LINKS,
  );
  log.info("Codex, Cursor and OpenCode read ~/.agents/skills directly; they get every skill.");
  const isDefault = links.length === DEFAULT_LINKS.length && links.every((l) => DEFAULT_LINKS.includes(l));
  return isDefault ? undefined : links;
}

/** Arrow-key wizard for one registry entry. Throws Cancelled on Esc / Ctrl-C. */
export async function askForSet(id: string): Promise<WizardResult> {
  const type = await choose(`What kind of source is "${id}"?`, [
    { value: "installer", label: "Installer", hint: "the vendor gave you a command such as npx @vendor/install …" },
    { value: "npm", label: "npm package", hint: "skill files ship inside a package; nothing is run" },
    { value: "skills-cli", label: "GitHub repo", disabled: "not supported yet" },
  ]);

  if (type === "npm") {
    const spec = await offerPin(
      await ask("Package name", { placeholder: "motion-ai", validate: (v) => (v ? undefined : "Required.") }),
    );
    const s = spinner();
    s.start("Looking for skills inside the package");
    const roots = skillRootsIn(spec);
    s.stop(roots.length ? `Found skills in ${roots.length} folder${roots.length === 1 ? "" : "s"}` : "No SKILL.md found");
    let where = "";
    if (roots.length) {
      where = await choose("Which folder holds the skills?", [
        ...roots.map((r) => {
          const [root, n] = r.split("|");
          return { value: root, label: root, hint: `${n} skill${n === "1" ? "" : "s"}` };
        }),
        { value: "", label: "Somewhere else…" },
      ]);
    }
    if (!where) where = await ask("Folder inside the package", { placeholder: "skills", validate: (v) => (v ? undefined : "Required.") });
    const links = await askLinks();
    return { set: { type, package: spec, path: where, ...(links ? { links } : {}) } satisfies NpmSet };
  }

  if (type === "skills-cli") {
    const source = await ask("GitHub repo", {
      placeholder: "mattpocock/skills",
      validate: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v) ? undefined : "Use owner/repo."),
    });
    const skills = list(await ask("Skills to install (comma-separated, empty = all)", { placeholder: "tdd, code-review" }));
    return { set: { type, source, ...(skills.length ? { skills } : {}) } satisfies SkillsCliSet };
  }

  // Installer: the vendor's own questions (which skills, renames) come later,
  // when it runs; here skillport only learns how to run it.
  const pasted = await ask("Paste the install command the vendor gave you (with or without the token)", {
    placeholder: "npx @vendor/install --token=… --global",
    validate: (v) => {
      try {
        return splitCommand(v).length ? undefined : "Required.";
      } catch (e) {
        return (e as Error).message;
      }
    },
  });
  let { command, secret } = extractSecret(splitCommand(pasted));
  if (secret) {
    log.info("Token taken out of the command; it goes to Keychain and the command uses {secret}.");
  } else if (command.some((a) => a.includes("{secret}"))) {
    if (!hasSecret(id)) secret = await askSecret("Token (stored in Keychain, never in the registry)");
  } else if (hasSecret(id) && (await confirm(`A token for "${id}" is already in Keychain. Use it?`))) {
    const flag = await ask("Flag the token goes in", { initial: "--token", validate: (v) => (/^-/.test(v) ? undefined : "Starts with -") });
    command = [...command, `${flag}={secret}`];
  } else if (await confirm("Does the installer need a token?", false)) {
    const flag = await ask("Flag the token goes in", { initial: "--token", validate: (v) => (/^-/.test(v) ? undefined : "Starts with -") });
    secret = await askSecret("Token (stored in Keychain, never in the registry)");
    command = [...command, `${flag}={secret}`];
  }
  const pkg = packageIndex(command);
  if (pkg >= 0) command[pkg] = await offerPin(command[pkg]);

  if (!command.some((a) => SCOPE_FLAG.test(a)) && (await confirm("Does it need a flag to install for your user (e.g. --global)?", false))) {
    command = [...command, ...splitCommand(await ask("Scope flag", { initial: "--global" }))];
  }

  const s = spinner();
  s.start("Reading the installer's --help");
  const found = suggestUnattendedFlag(readHelp(command));
  s.stop(found ? `It documents ${found}` : "No \"don't ask\" flag found in --help");
  const runs = await choose("For automatic updates: how does it skip its questions?", [
    ...(found ? [{ value: "found", label: `With ${found}`, hint: "found in --help" }] : []),
    { value: "other", label: "With another flag…" },
    { value: "none", label: "It never asks" },
    { value: "never", label: "It always asks", hint: "updates then need skl update -i" },
  ]);
  let unattended: string[] | undefined;
  if (runs === "found") unattended = [found!];
  if (runs === "other") unattended = splitCommand(await ask("Flag(s)", { placeholder: "--yes", validate: (v) => (v ? undefined : "Required.") }));
  if (runs === "none") unattended = [];

  const links = await askLinks();
  const set: InstallerSet = {
    type,
    command,
    ...(unattended !== undefined ? { unattended } : {}),
    ...(command.some((a) => a.includes("{secret}")) ? { secret: "keychain" as const } : {}),
    ...(links ? { links } : {}),
  };
  return { set, secret };
}
