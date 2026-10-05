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
  /**
   * Agents that do not read ~/.agents/skills and get symlinks, by id from
   * LINK_TARGETS. Omitted means ["claude-code"]. Codex, Cursor and OpenCode
   * read ~/.agents/skills themselves and need nothing here.
   */
  links?: string[];
}

/** Agents skillport can link into. Only ones whose skill folder is verified. */
export const LINK_TARGETS: Record<string, { label: string; dir: string[] }> = {
  "claude-code": { label: "Claude Code", dir: [".claude", "skills"] },
};
export const DEFAULT_LINKS = ["claude-code"];

export interface InstallerSet extends SetCommon {
  type: "installer";
  /**
   * argv as you would type it, including any scope flag the installer needs
   * (e.g. `--global`); `{secret}` is replaced at run time.
   */
  command: string[];
  /**
   * Extra args for an unattended run (stdin closed), e.g. `["-y"]`; `[]` if
   * the installer needs none. Omitted: the installer can only run
   * interactively, so `update` skips it until you pass `-i`.
   */
  unattended?: string[];
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
  home: string;
  registry: string;
  skillsDir: string;
  stateDir: string;
  /** Every agent folder skillport may link into (LINK_TARGETS), by id. */
  linkTargets: Record<string, string>;
  /** All of linkTargets' folders: where stale links of ours are cleaned up. */
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
    home,
    registry: process.env.SKILLPORT_REGISTRY ?? h(".config", "skillport", "registry.json"),
    skillsDir: h(".agents", "skills"),
    stateDir: h(".agents", ".skillport"),
    linkTargets: Object.fromEntries(Object.entries(LINK_TARGETS).map(([id, t]) => [id, h(...t.dir)])),
    links: Object.values(LINK_TARGETS).map((t) => h(...t.dir)),
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

/** The folders a set's skills are linked into. */
export function linkDirsFor(paths: Paths, set: SkillSet): string[] {
  return (set.links ?? DEFAULT_LINKS).map((id) => {
    const dir = paths.linkTargets[id];
    if (!dir) throw new Error(`Unknown link target "${id}". Known: ${Object.keys(paths.linkTargets).join(", ")}`);
    return dir;
  });
}

/** Whether skillport may run this set without you at the terminal. */
export function runsUnattended(set: ManagedSet): boolean {
  return set.type === "npm" || set.unattended !== undefined;
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
