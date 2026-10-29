import fs from "node:fs";
import path from "node:path";
import { describeExternal, externalSkills } from "./external.ts";
import type { Lock } from "./lock.ts";
import { type Manifest, type SkillId, type SourceId, splitSkillId } from "./manifest.ts";
import type { Paths } from "./registry.ts";
import { count, home } from "./report.ts";

// What `skl check` last found, so `skl status` and the TUI answer offline.
// See docs/SPEC-v2.md §5.4.

export type SourceStatus = { checkedAt: string } & (
  | { state: "up-to-date"; pinned?: string }
  | { state: "updates"; from: string; to: string; changed: string[]; added: string[]; removed: string[]; link?: string }
  | { state: "pinned-behind"; current: string; latest: string }
  | { state: "unknown"; reason: string }
  | { state: "error"; reason: string }
  | { state: "blocked"; collisions: { name: string; with: string }[] }
  | { state: "needs-token" }
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
