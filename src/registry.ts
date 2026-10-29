import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localDate, withPrefix } from "./transform.ts";
import { setUsingSource, validateEntry, validateLinkTargets } from "./validate.ts";

// The registry is what you want; it is hand-editable and the only file worth
// keeping under version control. See docs/SPEC.md §6.1.

export interface RenameRule {
  to: string;
  reason: string;
  at: string;
}

interface SetCommon {
  exclude?: string[];
  /**
   * Agents that do not read ~/.agents/skills and get symlinks, by id from
   * LINK_TARGETS or the registry's linkTargets. Omitted means ["claude-code"].
   * Codex, Cursor and OpenCode read ~/.agents/skills themselves and need
   * nothing here.
   */
  links?: string[];
}

/** Agents skillport can link into. Only ones whose skill folder is verified. */
export const LINK_TARGETS: Record<string, { label: string; dir: string[] }> = {
  "claude-code": { label: "Claude Code", dir: [".claude", "skills"] },
};
export const DEFAULT_LINKS = ["claude-code"];

/**
 * A folder of your own to link into, such as a second Claude Code account's
 * `$CLAUDE_CONFIG_DIR/skills`. `dir` is absolute or starts with `~/`.
 */
export interface LinkTarget {
  label?: string;
  dir: string;
}

/** Sets whose folders skillport writes, so it can rename their skills. */
interface ManagedCommon extends SetCommon {
  /** Default prefix offered when resolving a collision. */
  prefix?: string;
  /**
   * Install every skill of this set as `<namespace>-<name>`, including ones
   * the vendor adds later. Names that already carry it are left as they
   * are; a rename rule for a skill wins over it.
   */
  namespace?: string;
  rename?: Record<string, RenameRule>;
}

export interface InstallerSet extends ManagedCommon {
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
}

export interface NpmSet extends ManagedCommon {
  type: "npm";
  package: string;
  path: string;
}

export interface SkillsCliSet extends SetCommon {
  type: "skills-cli";
  source: string;
}

export type SkillSet = InstallerSet | NpmSet | SkillsCliSet;
export type ManagedSet = InstallerSet | NpmSet;

export interface Registry {
  version: 1;
  /** Link targets beyond LINK_TARGETS; sets opt in through `links`. */
  linkTargets?: Record<string, LinkTarget>;
  sets: Record<string, SkillSet>;
}

export interface Paths {
  home: string;
  registry: string;
  skillsDir: string;
  stateDir: string;
  /** Every agent folder skillport may link into (LINK_TARGETS and the registry's), by id. */
  linkTargets: Record<string, string>;
  /** All of linkTargets' folders: where stale links of ours are cleaned up. */
  links: string[];
  /** Folders vendor installers scatter copies into, scanned by doctor. */
  agentDirs: string[];
  skillLock: string;
  /** ~/.claude/plugins, where installed_plugins.json lives. */
  claudePlugins: string;
  /** v2: what you want (docs/SPEC-v2.md §5.1). */
  manifest: string;
  /** v2: your customizations, next to the manifest (§5.5). */
  patchesDir: string;
  /** v2: skl's own state under ~/.agents (§5.3). */
  sklDir: string;
  lockFile: string;
  storeDir: string;
  statusFile: string;
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
    claudePlugins: h(".claude", "plugins"),
    manifest: h(".config", "skl", "manifest.json"),
    patchesDir: h(".config", "skl", "patches"),
    sklDir: h(".agents", ".skl"),
    lockFile: h(".agents", ".skl", "lock.json"),
    storeDir: h(".agents", ".skl", "store"),
    statusFile: h(".agents", ".skl", "status.json"),
  };
}

/** Ids a set's `links` may name: the built-in targets, then the registry's. */
export function linkTargetIds(reg: Registry): string[] {
  return [...Object.keys(LINK_TARGETS), ...Object.keys(reg.linkTargets ?? {})];
}

/** What the wizard shows for each link target. */
export function linkTargetLabels(reg: Registry): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(LINK_TARGETS).map(([id, t]) => [id, t.label])),
    ...Object.fromEntries(Object.entries(reg.linkTargets ?? {}).map(([id, t]) => [id, t.label ?? id])),
  };
}

/**
 * Paths with the registry's link targets added. Their folders are also
 * scanned by doctor, like the built-in agent folders.
 */
export function withLinkTargets(paths: Paths, reg: Pick<Registry, "linkTargets">, file = paths.registry): Paths {
  const extra = Object.entries(reg.linkTargets ?? {}).map(([id, t]) => {
    const dir = path.resolve(t.dir.startsWith("~/") ? path.join(paths.home, t.dir.slice(2)) : t.dir);
    return [id, dir] as const;
  });
  if (!extra.length) return paths;
  const taken = [paths.skillsDir, paths.stateDir, paths.sklDir];
  const seen = new Set(paths.links);
  for (const [id, dir] of extra) {
    if (taken.some((t) => dir === t || dir.startsWith(`${t}${path.sep}`) || t.startsWith(`${dir}${path.sep}`))) {
      throw new Error(`${file}: link target "${id}" (${dir}) overlaps skillport's own folders; pick an agent's skills folder.`);
    }
    if (seen.has(dir)) throw new Error(`${file}: link target "${id}" uses ${dir}, which another target already uses.`);
    seen.add(dir);
  }
  const dirs = extra.map(([, dir]) => dir);
  return {
    ...paths,
    linkTargets: { ...paths.linkTargets, ...Object.fromEntries(extra) },
    links: [...paths.links, ...dirs],
    agentDirs: [...new Set([...paths.agentDirs, ...dirs])],
  };
}

export function readRegistry(file: string): Registry {
  if (!fs.existsSync(file)) return { version: 1, sets: {} };
  const reg = JSON.parse(fs.readFileSync(file, "utf8")) as Registry;
  if (reg.version !== 1) throw new Error(`${file}: unsupported registry version ${reg.version}`);
  // Every entry, hand-edited or not: ids become folder names, packages reach
  // npm pack, paths are joined under the sandbox.
  const problems = Object.entries(reg.sets).flatMap(([id, set]) =>
    validateEntry(id, set, linkTargetIds(reg)).map((p) => `${id}: ${p}`),
  );
  problems.push(...validateLinkTargets(reg.linkTargets, Object.keys(LINK_TARGETS)));
  // One set per npx skills source: the lock cannot tell two of them apart.
  const earlier: Record<string, SkillSet> = {};
  for (const [id, set] of Object.entries(reg.sets)) {
    if (set.type === "skills-cli" && typeof set.source === "string") {
      const twin = setUsingSource(earlier, set.source);
      if (twin) problems.push(`${id}: source ${set.source} is already used by set "${twin}"`);
    }
    earlier[id] = set;
  }
  if (problems.length) throw new Error(`${file} has problems:\n  ${problems.join("\n  ")}`);
  return reg;
}

export function writeRegistry(file: string, reg: Registry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);
}

/** One collision answer: leave a skill out, give it another name, or undo either. */
export type Resolution = { exclude: true } | { to: string; reason: string } | { undo: true };

/**
 * Record a resolution for `original` (the vendor's name) in a set's entry.
 * A skills-cli set can only leave a skill out: its names belong to npx skills.
 */
export function applyResolution(reg: Registry, id: string, original: string, r: Resolution): void {
  const set = getSet(reg, id);
  if (!isManaged(set) && "to" in r) {
    throw new Error(`"${id}" is a skills-cli set; its names belong to npx skills. Use --exclude, or rename the other side.`);
  }
  set.exclude = (set.exclude ?? []).filter((n) => n !== original);
  if ("exclude" in r) set.exclude.push(original);
  if (!set.exclude.length) delete set.exclude;
  if (!isManaged(set)) return;
  if (set.rename) delete set.rename[original];
  if ("to" in r) set.rename = { ...(set.rename ?? {}), [original]: { to: r.to, reason: r.reason, at: localDate() } };
  if (set.rename && !Object.keys(set.rename).length) delete set.rename;
}

/** The folders a set's skills are linked into. */
export function linkDirsFor(paths: Paths, set: SkillSet): string[] {
  return (set.links ?? DEFAULT_LINKS).map((id) => {
    const dir = paths.linkTargets[id];
    if (!dir) throw new Error(`Unknown link target "${id}". Known: ${Object.keys(paths.linkTargets).join(", ")}`);
    return dir;
  });
}

/** The name a set installs a vendor skill under: its rename rule, else the namespace, else as shipped. */
export function skillName(set: ManagedSet, original: string): string {
  return set.rename?.[original]?.to ?? (set.namespace ? withPrefix(original, set.namespace) : original);
}

/** The prefix offered for a set's collisions: its own setting, else its id. */
export function prefixOf(set: SkillSet, id: string): string {
  return (isManaged(set) && set.prefix) || id;
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
