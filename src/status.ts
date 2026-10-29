import fs from "node:fs";
import path from "node:path";
import { describeExternal, externalSkills } from "./external.ts";
import type { Lock } from "./lock.ts";
import { type Manifest, type SkillId, type SourceId, installedName, splitSkillId } from "./manifest.ts";
import { mergeDir, patchFiles, readMergeInfo } from "./patch.ts";
import type { Paths } from "./paths.ts";
import { count, home } from "./report.ts";
import { treeHash } from "./treehash.ts";

// What `skl check` last found, so `skl status` and the TUI answer offline.
// See docs/SPEC.md §5.4.

export type SourceStatus = { checkedAt: string } & (
  | { state: "up-to-date"; pinned?: string }
  | { state: "updates"; from: string; to: string; changed: string[]; added: string[]; removed: string[]; link?: string }
  | { state: "pinned-behind"; current: string; latest: string }
  | { state: "unknown"; reason: string }
  | { state: "error"; reason: string }
  | { state: "blocked"; collisions: { name: string; with: string }[] }
  | { state: "needs-token" }
  /** No version to compare without running it; update runs it. */
  | { state: "unpinned" }
);

export interface SkillFlags {
  customized?: true;
  edited?: true;
  /** The merge folder. */
  conflict?: string;
}

export interface Status {
  checkedAt: string;
  sources: Record<SourceId, SourceStatus>;
  skills: Record<SkillId, SkillFlags>;
}

export function readStatus(file: string): Status | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Status;
}

export function writeStatus(file: string, status: Status): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function describeState(s: SourceStatus, type: string): string {
  switch (s.state) {
    case "up-to-date":
      return s.pinned ? `up to date (pinned ${s.pinned})` : "up to date";
    case "updates": {
      const parts = [
        s.changed.length ? count(s.changed.length, "update") : "",
        s.added.length ? `${s.added.length} new` : "",
        s.removed.length ? `${s.removed.length} removed` : "",
      ].filter(Boolean);
      return parts.join(" · ");
    }
    case "pinned-behind":
      return type === "installer" ? `installer ${s.latest} available` : `${s.latest} available (pinned ${s.current})`;
    case "unknown":
      return `can't tell: ${s.reason}`;
    case "error":
      return s.reason;
    case "blocked":
      return `blocked: ${s.collisions.length === 1 ? "name collision" : `${s.collisions.length} name collisions`}`;
    case "needs-token":
      return "token missing: skl secret";
    case "unpinned":
      return "not pinned: update to compare";
  }
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The table `skl status` prints; offline, from status.json alone. */
export function formatStatus(manifest: Manifest, lock: Lock, status: Status | null, now = Date.now()): string {
  const ids = Object.keys(manifest.sources) as SourceId[];
  if (!ids.length) return "No sources yet. Add one: skl add <id> --github <owner/repo>";
  const rows = ids.map((id) => {
    const s = status?.sources[id];
    const type = manifest.sources[id].type;
    return [id, type, s ? describeState(s, type) : "not checked yet: skl check", s ? ago(s.checkedAt, now) : ""];
  });
  const table = [["SOURCE", "TYPE", "STATE", "CHECKED"], ...rows];
  const widths = [0, 1, 2].map((i) => Math.max(...table.map((r) => r[i].length)) + 2);
  const lines = table.map((r) => r.map((c, i) => (i < 3 ? c.padEnd(widths[i]) : c)).join("").trimEnd());
  const flagged = Object.entries(status?.skills ?? {}).flatMap(([id, f]) => {
    const name = lock.skills[id as SkillId]?.name ?? id;
    return [
      f.edited ? `  edited      ${name}: changed in place; skl keeps it (skl edit ${id} --from-disk to keep it as a patch)` : "",
      f.conflict ? `  conflict    ${name}: resolve in ${home(f.conflict)}, then skl edit ${id}` : "",
      f.customized ? `  customized  ${name}` : "",
    ].filter(Boolean);
  });
  return [...lines, ...(flagged.length ? ["", ...flagged] : [])].join("\n");
}

/** `skl which <name>`: where an installed skill came from. */
export function which(paths: Paths, manifest: Manifest, lock: Lock, name: string, now = Date.now()): string {
  const hit = (Object.entries(lock.skills) as [SkillId, Lock["skills"][SkillId]][]).find(([, s]) => s.name === name);
  if (!hit) {
    const ext = externalSkills(paths, lock).get(name);
    if (ext) return `${name} is ${describeExternal(ext)}; skl does not manage it.`;
    throw new Error(`No installed skill is named ${name}.`);
  }
  const [id, s] = hit;
  const { source: sid, original } = splitSkillId(id);
  const source = manifest.sources[sid];
  const from = !source
    ? "no longer in the manifest"
    : source.type === "github"
      ? `github ${source.repo}`
      : source.type === "npm"
        ? `npm ${source.package}`
        : source.type === "installer"
          ? `installer ${source.command.join(" ")}`
          : `local ${source.path}`;
  const resolved = lock.sources[sid]?.resolved ?? "";
  const version = source?.type === "github" || source?.type === "local" ? resolved.slice(0, 7) : resolved;
  return [
    name,
    `  source    ${sid} (${from})`,
    `  original  ${original}`,
    `  version   ${version}`,
    `  updated   ${s.updatedAt.slice(0, 16).replace("T", " ")} UTC (${ago(s.updatedAt, now)})`,
    ...(s.patch ? ["  customized: yes (skl edit)"] : []),
  ].join("\n");
}

/** One skill as `skl status --json` reports it; paths are absolute so an agent can open them. */
export interface SkillReport {
  id: SkillId;
  name: string;
  /** The folder agents read; absent while a first install waits on a merge. */
  dir?: string;
  /** Your patch and its note, when the skill is customized. */
  patch?: string;
  note?: string;
  /** Changed in ~/.agents/skills since skl wrote it: `skl edit <id> --from-disk` keeps it. */
  edited: boolean;
  /** A merge to resolve in `merged`, then finish with `skl edit <id>`. */
  conflict?: { dir: string; merged: string };
}

/**
 * Every installed skill and every merge waiting, read from disk now rather
 * than from the last check: a merge folder appears during an update, and on
 * a new machine its skill is not installed yet.
 */
export function skillReports(paths: Paths, manifest: Manifest, lock: Lock): SkillReport[] {
  const ids = new Set(Object.keys(lock.skills) as SkillId[]);
  const mergeRoot = path.join(paths.sklDir, "merge");
  for (const source of fs.existsSync(mergeRoot) ? fs.readdirSync(mergeRoot) : []) {
    for (const original of fs.readdirSync(path.join(mergeRoot, source))) ids.add(`${source}/${original}` as SkillId);
  }
  return [...ids].sort().flatMap((id): SkillReport[] => {
    const { source, original } = splitSkillId(id);
    if (!manifest.sources[source]) return [];
    const entry = lock.skills[id];
    const name = entry?.name ?? installedName(source, original, manifest.sources[source]);
    const dir = path.join(paths.skillsDir, name);
    const files = patchFiles(paths, source, original);
    const merge = mergeDir(paths, source, original);
    return [
      {
        id,
        name,
        ...(entry && fs.existsSync(dir) ? { dir } : {}),
        ...(fs.existsSync(files.patch) ? { patch: files.patch } : {}),
        ...(fs.existsSync(files.note) ? { note: files.note } : {}),
        edited: Boolean(entry && fs.existsSync(dir) && treeHash(dir) !== entry.output),
        ...(readMergeInfo(merge) ? { conflict: { dir: merge, merged: path.join(merge, "MERGED") } } : {}),
      },
    ];
  });
}
