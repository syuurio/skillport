import os from "node:os";
import path from "node:path";

// Where skl reads and writes. See docs/SPEC.md §5.

/** Agents skl can link into. Only ones whose skill folder is verified. */
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

export interface Paths {
  home: string;
  skillsDir: string;
  /** Every agent folder skl may link into (LINK_TARGETS and the manifest's), by id. */
  linkTargets: Record<string, string>;
  /** All of linkTargets' folders: where stale links of ours are cleaned up. */
  links: string[];
  /** Folders vendor installers scatter copies into, scanned by doctor. */
  agentDirs: string[];
  skillLock: string;
  /** What you want (§5.1). */
  manifest: string;
  /** Your customizations, next to the manifest (§5.5). */
  patchesDir: string;
  /** skl's own state under ~/.agents (§5.3). */
  sklDir: string;
  lockFile: string;
  storeDir: string;
  statusFile: string;
}

/**
 * `SKILLPORT_HOME` relocates every path skl manages (for tests and dry
 * experiments). Keychain and npm keep using the real home.
 */
export function defaultPaths(home = process.env.SKILLPORT_HOME ?? os.homedir()): Paths {
  const h = (...p: string[]) => path.join(home, ...p);
  return {
    home,
    skillsDir: h(".agents", "skills"),
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
    manifest: h(".config", "skl", "manifest.json"),
    patchesDir: h(".config", "skl", "patches"),
    sklDir: h(".agents", ".skl"),
    lockFile: h(".agents", ".skl", "lock.json"),
    storeDir: h(".agents", ".skl", "store"),
    statusFile: h(".agents", ".skl", "status.json"),
  };
}

/** Paths with the manifest's link targets added. Doctor scans their folders too, like the built-in agent folders. */
export function withLinkTargets(paths: Paths, manifest: { linkTargets?: Record<string, LinkTarget> }, file = paths.manifest): Paths {
  const extra = Object.entries(manifest.linkTargets ?? {}).map(([id, t]) => {
    const dir = path.resolve(t.dir.startsWith("~/") ? path.join(paths.home, t.dir.slice(2)) : t.dir);
    return [id, dir] as const;
  });
  if (!extra.length) return paths;
  const taken = [paths.skillsDir, paths.sklDir];
  const seen = new Set(paths.links);
  for (const [id, dir] of extra) {
    if (taken.some((t) => dir === t || dir.startsWith(`${t}${path.sep}`) || t.startsWith(`${dir}${path.sep}`))) {
      throw new Error(`${file}: link target "${id}" (${dir}) overlaps skl's own folders; pick an agent's skills folder.`);
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
