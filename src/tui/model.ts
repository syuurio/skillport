import type { Lock, SkillLock } from "../lock.ts";
import { type Manifest, type SkillId, type SourceId, splitSkillId } from "../manifest.ts";
import { type SourceStatus, type Status, ago, describeState } from "../status.ts";
import { githubRepo } from "../validate.ts";

// What the TUI shows, computed from the manifest, the lock and status.json
// alone, and what each key does. No terminal, no network: the tests drive
// these directly. See docs/SPEC-v2.md §12.

export type Tone = "warn" | "ok" | "bad" | "dim";

export interface SourceRow {
  id: SourceId;
  mark: string;
  tone: Tone;
  state: string;
}

export interface SkillRow {
  /** Original name. */
  original: string;
  /** Installed name, or the original for one not installed. */
  name: string;
  note: string;
  /** Upstream added it and you have not installed it. */
  isNew: boolean;
}

function tone(s: SourceStatus | undefined): Tone {
  switch (s?.state) {
    case "updates":
    case "pinned-behind":
      return "warn";
    case "up-to-date":
      return "ok";
    case "blocked":
    case "error":
    case "needs-token":
      return "bad";
    default:
      return "dim";
  }
}

const MARKS: Record<Tone, string> = { warn: "●", ok: "✓", bad: "✗", dim: "?" };

export function sourceRows(manifest: Manifest, status: Status | null): SourceRow[] {
  return (Object.keys(manifest.sources) as SourceId[]).map((id) => {
    const s = status?.sources[id];
    const t = tone(s);
    return { id, mark: MARKS[t], tone: t, state: s ? describeState(s, manifest.sources[id].type) : "not checked yet" };
  });
}

/** The right pane's title: the source and where it comes from. */
export function sourceTitle(manifest: Manifest, id: SourceId): string {
  const s = manifest.sources[id];
  const from = s.type === "github" ? githubRepo(s.repo) : s.type === "npm" ? s.package : s.type === "local" ? s.path : s.command.join(" ");
  return `${id} · ${from}`;
}

export function skillRows(lock: Lock, status: Status | null, id: SourceId): SkillRow[] {
  const s = status?.sources[id];
  const updates = s?.state === "updates" ? s : null;
  const installed = (Object.entries(lock.skills) as [SkillId, SkillLock][])
    .filter(([sid]) => splitSkillId(sid).source === id)
    .map(([sid, entry]): SkillRow => {
      const original = splitSkillId(sid).original as string;
      const flags = status?.skills[sid] ?? {};
      const notes = [
        updates?.changed.includes(original) ? `update   ${updates.from}→${updates.to}` : "",
        updates?.removed.includes(original) ? "removed upstream" : "",
        flags.conflict ? "conflict" : "",
        flags.edited ? "edited in place" : "",
        flags.customized ? "customized" : "",
      ].filter(Boolean);
      return { original, name: entry.name, note: notes.join(" · "), isNew: false };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const fresh = (updates?.added ?? []).map((original): SkillRow => ({ original, name: original, note: "new upstream (not picked)", isNew: true }));
  return [...installed, ...fresh];
}

export function headerRight(status: Status | null, now = Date.now()): string {
  return status ? `checked ${ago(status.checkedAt, now)} · r to re-check` : "not checked yet · r to check";
}

export type Pane = "sources" | "skills";

export type Action =
  | { kind: "move"; by: 1 | -1 }
  | { kind: "pane"; to: Pane }
  | { kind: "update"; all: boolean }
  | { kind: "diff" }
  | { kind: "open" }
  | { kind: "pick" }
  | { kind: "recheck" }
  | { kind: "quit" }
  | { kind: "back" }
  | { kind: "apply" };

export interface Key {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  tab?: boolean;
  escape?: boolean;
}

/** The list's keys (SPEC §12). Views that are not the list take only the arrows, space, y, Esc and q. */
export function listAction(input: string, key: Key): Action | null {
  if (key.upArrow) return { kind: "move", by: -1 };
  if (key.downArrow) return { kind: "move", by: 1 };
  if (key.rightArrow || key.tab) return { kind: "pane", to: "skills" };
  if (key.leftArrow) return { kind: "pane", to: "sources" };
  const keys: Record<string, Action> = {
    u: { kind: "update", all: false },
    U: { kind: "update", all: true },
    d: { kind: "diff" },
    o: { kind: "open" },
    " ": { kind: "pick" },
    r: { kind: "recheck" },
    q: { kind: "quit" },
  };
  return keys[input] ?? null;
}

export function viewAction(input: string, key: Key): Action | null {
  if (key.upArrow) return { kind: "move", by: -1 };
  if (key.downArrow) return { kind: "move", by: 1 };
  if (key.escape) return { kind: "back" };
  if (input === "y") return { kind: "apply" };
  if (input === " ") return { kind: "pick" };
  if (input === "q") return { kind: "quit" };
  return null;
}

export const LIST_HINTS = "↑↓ select  ←→ pane  u update  U update all  d diff  o open link  space pick new  r re-check  q quit";
