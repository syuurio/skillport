import { ask, choose } from "./prompt.ts";
import type { InstallerSet, NpmSet, Registry, SkillSet, SkillsCliSet } from "./registry.ts";

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

const words = (line: string) => (line.trim() ? splitCommand(line) : []);
const list = (line: string) => line.split(",").map((s) => s.trim()).filter(Boolean);

/** Problems with an entry; empty when it can be written. */
export function validateSet(id: string, set: SkillSet, reg: Registry): string[] {
  const problems: string[] = [];
  if (!ID_RE.test(id)) problems.push(`set id "${id}" must use a-z, 0-9 and single hyphens`);
  if (reg.sets[id]) problems.push(`set "${id}" already exists`);
  const isWords = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
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

/** Ask for an entry on the terminal. */
export async function askForSet(id: string): Promise<SkillSet> {
  const type = await choose(`Type of set "${id}"?`, [
    { value: "installer", label: "installer   a vendor CLI that installs skills (npx …)" },
    { value: "npm", label: "npm         copy skills out of a pinned npm package, no code runs" },
    { value: "skills-cli", label: "skills-cli  a GitHub repo installed through npx skills" },
  ]);
  if (type === "installer") {
    console.log("Command as you would type it, with any scope flag (e.g. --global).");
    console.log("Write the token as {secret}; it is read from Keychain at run time.");
    const command = words(await ask("  command: "));
    const secret = command.some((a) => a.includes("{secret}"));
    console.log("Args that make it run without asking (e.g. -y). Leave empty if it needs none;");
    console.log('type "none" if it can only run interactively.');
    const u = await ask("  unattended args: ");
    const set: InstallerSet = { type, command, ...(secret ? { secret: "keychain" as const } : {}) };
    if (u.trim() !== "none") set.unattended = words(u);
    const stage = await ask("  agent folder the installer should detect [.claude]: ");
    if (stage.trim() && stage.trim() !== ".claude") {
      set.stage = [stage.trim()];
      set.harvest = (await ask(`  where its skills land under that HOME [${stage.trim()}/skills]: `)).trim() || `${stage.trim()}/skills`;
    }
    const prefix = (await ask(`  prefix offered on name collisions [${id}]: `)).trim();
    if (prefix) set.prefix = prefix;
    return set;
  }
  if (type === "npm") {
    const set: NpmSet = {
      type,
      package: (await ask("  package, pinned (name@version): ")).trim(),
      path: (await ask("  skills folder inside the package [skills]: ")).trim() || "skills",
    };
    return set;
  }
  const set: SkillsCliSet = { type, source: (await ask("  GitHub source (owner/repo): ")).trim() };
  const skills = list(await ask("  skills to install, comma-separated [all]: "));
  if (skills.length) set.skills = skills;
  return set;
}
