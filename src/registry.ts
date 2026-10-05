import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The registry is what you want; it is hand-editable and the only file worth
// keeping under version control. See docs/SPEC.md §6.1.

export interface RenameRule {
  to: string;
  reason: string;
  at: string;
}

interface SetCommon {
  /** Vendor skill names to install; omitted means all. */
  skills?: string[];
  exclude?: string[];
}

export interface InstallerSet extends SetCommon {
  type: "installer";
  /** argv without `--global`/`-y`; `{secret}` is replaced at run time. */
  command: string[];
  secret?: "keychain";
  /** Folders created under the fake HOME so the installer detects one agent. */
  stage?: string[];
  /** Where that agent's skills land under the fake HOME. */
  harvest?: string;
  /** Default prefix offered when resolving a collision. */
  prefix?: string;
  rename?: Record<string, RenameRule>;
}

export interface NpmSet extends SetCommon {
  type: "npm";
  package: string;
  path: string;
  prefix?: string;
  rename?: Record<string, RenameRule>;
}

export interface SkillsCliSet extends SetCommon {
  type: "skills-cli";
  source: string;
}

export type SkillSet = InstallerSet | NpmSet | SkillsCliSet;
export type ManagedSet = InstallerSet | NpmSet;

export interface Registry {
  version: 1;
  sets: Record<string, SkillSet>;
}

export interface Paths {
  registry: string;
  skillsDir: string;
  stateDir: string;
  /** Agent folders that do not read skillsDir and get symlinks. */
  links: string[];
  /** Folders vendor installers scatter copies into, scanned by doctor. */
  agentDirs: string[];
  skillLock: string;
  pluginCache: string;
}

/**
 * `SKILLPORT_HOME` relocates every path skillport manages (for tests and dry
 * experiments). Keychain and npm keep using the real home.
 */
export function defaultPaths(home = process.env.SKILLPORT_HOME ?? os.homedir()): Paths {
  const h = (...p: string[]) => path.join(home, ...p);
  return {
    registry: process.env.SKILLPORT_REGISTRY ?? h(".config", "skillport", "registry.json"),
    skillsDir: h(".agents", "skills"),
    stateDir: h(".agents", ".skillport"),
    links: [h(".claude", "skills")],
    agentDirs: [
      h(".claude", "skills"),
      h(".codex", "skills"),
      h(".cursor", "skills"),
      h(".config", "opencode", "skills"),
      h(".gemini", "skills"),
    ],
    skillLock: h(".agents", ".skill-lock.json"),
    pluginCache: h(".claude", "plugins", "cache"),
  };
}

export function readRegistry(file: string): Registry {
  if (!fs.existsSync(file)) return { version: 1, sets: {} };
  const reg = JSON.parse(fs.readFileSync(file, "utf8")) as Registry;
  if (reg.version !== 1) throw new Error(`${file}: unsupported registry version ${reg.version}`);
  // Set ids become folder names under staging and trash.
  for (const id of Object.keys(reg.sets)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error(`${file}: set id "${id}" must use a-z, 0-9 and single hyphens.`);
  }
  return reg;
}

export function writeRegistry(file: string, reg: Registry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);
}

export function isManaged(set: SkillSet): set is ManagedSet {
  return set.type === "installer" || set.type === "npm";
}

export function getSet(reg: Registry, id: string | undefined): SkillSet {
  const set = id ? reg.sets[id] : undefined;
  if (!set) {
    const known = Object.keys(reg.sets).join(", ") || "(none)";
    throw new Error(`Unknown set "${id ?? ""}". Registered: ${known}`);
  }
  return set;
}
