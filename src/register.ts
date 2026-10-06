import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { latestVersion, npmPack, sandboxEnv } from "./acquire.ts";
import { withTempDir } from "./fsutil.ts";
import { hasSecret } from "./keychain.ts";
import { ask, askSecret, choose, chooseMany, confirm, log, spinner } from "./prompt.ts";
import { DEFAULT_LINKS, LINK_TARGETS, type InstallerSet, type NpmSet, type Paths, type Registry, type SkillSet, type SkillsCliSet } from "./registry.ts";
import { listSource } from "./skillscli.ts";
import { extractSecret, isPackageName, isPinnedSpec, leadingEnv, setUsingSource, sourceProblem, usesSecret, validateEntry } from "./validate.ts";

// `skl register`: add a set to the registry by answering questions, or from
// `--json` for scripts and agents. Either way the entry is validated before
// it is written.


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


/** Problems with an entry about to be added; empty when it can be written. */
export function validateSet(id: string, set: SkillSet, reg: Registry): string[] {
  const problems = reg.sets[id] ? [`set "${id}" already exists`] : [];
  // Same rule readRegistry enforces, checked before saving so a second set
  // for one source cannot be written and then block every command.
  if (set.type === "skills-cli" && typeof set.source === "string") {
    const twin = setUsingSource(reg.sets, set.source, id);
    if (twin) problems.push(`source ${set.source} is already used by set "${twin}"`);
  }
  return [...problems, ...validateEntry(id, set, Object.keys(LINK_TARGETS))];
}

/** Index of the package an `npx`/`pnpm dlx`/`bunx` command runs, or -1. */
export function packageIndex(argv: string[]): number {
  const runners = new Set(["npx", "bunx", "dlx", "pnpx"]);
  const at = argv.findIndex((a) => runners.has(a));
  if (at < 0) return -1;
  return argv.findIndex((a, i) => i > at && !a.startsWith("-"));
}


const bareName = (spec: string) => spec.replace(/^(@?[^@]+)@.*$/, "$1");

const latest = (name: string) => (isPackageName(name) ? withTempDir("view", (dir) => latestVersion(name, dir)) : null);

/** Folders under `pkg` that hold skill folders, most skills first. */
export function countSkillRoots(pkg: string): { root: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of fs.readdirSync(pkg, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || e.name !== "SKILL.md") continue;
    const root = path.relative(pkg, path.dirname(e.parentPath)) || ".";
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([root, count]) => ({ root, count }));
}

/** Skill folders in a pinned registry package; empty for anything else. */
export function skillRootsIn(spec: string): { root: string; count: number }[] {
  if (!isPinnedSpec(spec)) return [];
  return withTempDir("pack", (dir) => {
    try {
      return countSkillRoots(npmPack(spec, dir));
    } catch {
      return [];
    }
  });
}

/** Pin `spec` to its latest version, asking first. Returns the spec to use. */
async function offerPin(spec: string): Promise<string> {
  if (isPinnedSpec(spec)) return spec;
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
  return withTempDir("help", (tmp) => {
    const argv = [...leadingEnv(command).rest.filter((a) => !a.includes("{secret}")), "--help"];
    const r = spawnSync(argv[0], argv.slice(1), {
      cwd: tmp,
      encoding: "utf8",
      env: sandboxEnv(tmp, tmp),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  });
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

const askTokenFlag = () =>
  ask("Flag the token goes in", { initial: "--token", validate: (v) => (/^-/.test(v) ? undefined : "Starts with -") });

/** Arrow-key wizard for one registry entry. Throws Cancelled on Esc / Ctrl-C. */
export async function askForSet(id: string, paths: Paths): Promise<WizardResult> {
  const type = await choose(`What kind of source is "${id}"?`, [
    { value: "installer", label: "Installer", hint: "the vendor gave you a command such as npx @vendor/install …" },
    { value: "npm", label: "npm package", hint: "skill files ship inside a package; nothing is run" },
    { value: "skills-cli", label: "npx skills source", hint: "GitHub owner/repo, a URL, or a name npx skills knows" },
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
        ...roots.map(({ root, count }) => ({ value: root, label: root, hint: `${count} skill${count === 1 ? "" : "s"}` })),
        { value: "", label: "Somewhere else…" },
      ]);
    }
    if (!where) where = await ask("Folder inside the package", { placeholder: "skills", validate: (v) => (v ? undefined : "Required.") });
    const links = await askLinks();
    return { set: { type, package: spec, path: where, ...(links ? { links } : {}) } satisfies NpmSet };
  }

  if (type === "skills-cli") {
    const source = await ask("Source, as you would pass it to npx skills add", {
      placeholder: "mattpocock/skills",
      // Checked before npx skills ever sees it (a credential in it would reach the network).
      validate: (v) => sourceProblem(v),
    });
    // Only a check that the source answers: which skills to install is asked
    // on skl add and remembered in state, not written here.
    const s = spinner();
    s.start(`Asking npx skills what ${source} offers`);
    try {
      s.stop(`${listSource(paths, source).length} skills available; skl add asks which to install`);
    } catch {
      s.stop("Could not list it now; skl add will try again");
    }
    const links = await askLinks();
    return { set: { type, source, ...(links ? { links } : {}) } satisfies SkillsCliSet };
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
  } else if (usesSecret({ command })) {
    if (!hasSecret(id)) secret = await askSecret("Token (stored in Keychain, never in the registry)");
  } else if (hasSecret(id) && (await confirm(`A token for "${id}" is already in Keychain. Use it?`))) {
    const flag = await askTokenFlag();
    command = [...command, `${flag}={secret}`];
  } else if (await confirm("Does the installer need a token?", false)) {
    const flag = await askTokenFlag();
    secret = await askSecret("Token (stored in Keychain, never in the registry)");
    command = [...command, `${flag}={secret}`];
  }
  const pkg = packageIndex(command);
  if (pkg >= 0) command[pkg] = await offerPin(command[pkg]);

  if (!command.some((a) => SCOPE_FLAG.test(a)) && (await confirm("Does it need a flag to install for your user (e.g. --global)?", false))) {
    command = [...command, ...splitCommand(await ask("Scope flag", { initial: "--global" }))];
  }

  // Reading --help runs the vendor's code, so it is opt-in.
  let found: string | null = null;
  if (await confirm(`Run "${leadingEnv(command).rest.filter((a) => !a.includes("{secret}")).join(" ")} --help" in a sandbox to find its "don't ask" flag? This runs the vendor's code.`)) {
    const s = spinner();
    s.start("Reading the installer's --help");
    found = suggestUnattendedFlag(readHelp(command));
    s.stop(found ? `It documents ${found}` : "No \"don't ask\" flag found in --help");
  }
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
    ...(usesSecret({ command, unattended }) ? { secret: "keychain" as const } : {}),
    ...(links ? { links } : {}),
  };
  return { set, secret };
}
