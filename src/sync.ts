import fs from "node:fs";
import path from "node:path";
import type { Fetched } from "./adapters/index.ts";
import { fetchLocal } from "./adapters/local.ts";
import { isOursOrFree, link, moveToTrash, trashDir, unlink } from "./apply.ts";
import { describeExternal, externalSkills, foreignInTarget } from "./external.ts";
import { type Lock, type SkillLock, writeLock } from "./lock.ts";
import { type Manifest, type SkillId, type SkillName, type Source, type SourceId, installedName, skillId, splitSkillId } from "./manifest.ts";
import { DEFAULT_LINKS, type Paths } from "./registry.ts";
import { type Rewrite, render } from "./render.ts";
import { putInStore, storedAt } from "./store.ts";
import { isValidSkillName } from "./transform.ts";
import { treeHash } from "./treehash.ts";

// Make ~/.agents/skills and the link targets match the manifest and the lock.
// Offline: local sources are read again, sources the caller just fetched
// (add, update) are taken from `fetched`, and every other source installs
// what the lock's `base` names in the store.

interface Want {
  id: SkillId;
  source: SourceId;
  original: SkillName;
  base: string;
  name: string;
  dirs: string[];
}

const selected = (source: Source, original: string) =>
  (!source.pick || source.pick.includes(original)) && !source.exclude?.includes(original);

/** The link target folders a source's skills go into. */
export function linkDirs(paths: Paths, manifest: Manifest, source: Source): string[] {
  return (source.links ?? manifest.targets ?? DEFAULT_LINKS).map((id) => {
    const dir = paths.linkTargets[id];
    if (!dir) throw new Error(`Unknown link target "${id}". Known: ${Object.keys(paths.linkTargets).join(", ")}`);
    return dir;
  });
}

/** Whether `name` is linked into exactly `dirs` among the folders skl links into. */
function linksMatch(paths: Paths, name: string, dirs: string[]): boolean {
  const target = path.join(paths.skillsDir, name);
  return paths.links.every((dir) => {
    const at = path.join(dir, name);
    const ours = Boolean(fs.lstatSync(at, { throwIfNoEntry: false })) && isOursOrFree(at, target);
    return ours === dirs.includes(dir);
  });
}

export interface SyncOptions {
  now?: string;
  /** Sources fetched just now, by id. */
  fetched?: ReadonlyMap<SourceId, Fetched>;
  /** Replace skills you changed in place; your copies go to trash. */
  discardEdits?: boolean;
  /** Compute the changes only: nothing on disk or in the lock changes. */
  dryRun?: boolean;
  /** New skills you chose to install this run. */
  accept?: ReadonlySet<SkillId>;
  /** You were shown every skill of the fetched sources, so all of them count as seen. */
  offeredNow?: boolean;
}

export type SyncChange =
  | { kind: "install"; id: SkillId; name: string; replaced: boolean; rewrites: Rewrite[] }
  | { kind: "relink"; id: SkillId; name: string }
  | { kind: "remove"; id: SkillId; name: string }
  | { kind: "edited"; id: SkillId; name: string }
  | { kind: "offered"; id: SkillId };

/** The lines `skl sync` prints for its changes. */
export function describeSync(changes: SyncChange[]): string[] {
  return changes.flatMap((c) => {
    switch (c.kind) {
      case "install":
        return [`${c.id} -> ${c.name}`, ...describe(c.rewrites)];
      case "relink":
        return [`${c.id} -> ${c.name}`];
      case "remove":
        return [`removed ${c.name} (${c.id})`];
      case "edited":
        return [`edited ${c.name} (${c.id}) was changed in place; kept as is`, "  to replace it with skl's version: skl sync --discard-edits"];
      case "offered":
        return [`new ${c.id} (not installed; skl update ${splitSkillId(c.id).source} --pick)`];
    }
  });
}

/** Installed skills whose folder is no longer what skl wrote: you changed them in place. */
function editedInPlace(paths: Paths, lock: Lock): Map<SkillId, SkillLock> {
  const edited = new Map<SkillId, SkillLock>();
  for (const [id, entry] of Object.entries(lock.skills) as [SkillId, SkillLock][]) {
    const dest = path.join(paths.skillsDir, entry.name);
    if (fs.lstatSync(dest, { throwIfNoEntry: false })?.isDirectory() && treeHash(dest) !== entry.output) edited.set(id, entry);
  }
  return edited;
}

/** The skills the manifest asks for; stores what was fetched and records it in the lock. */
function wanted(paths: Paths, manifest: Manifest, lock: Lock, now: string, opts: SyncOptions): { wants: Want[]; offered: SkillId[] } {
  const fetched = opts.fetched ?? new Map<SourceId, Fetched>();
  const wants: Want[] = [];
  const offered: SkillId[] = [];
  const problems: string[] = [];
  for (const [sid, source] of Object.entries(manifest.sources) as [SourceId, Source][]) {
    const dirs = linkDirs(paths, manifest, source);
    const add = (original: SkillName, base: string) =>
      wants.push({ id: skillId(sid, original), source: sid, original, base, name: installedName(sid, original, source), dirs });
    const fresh = source.type === "local" ? fetchLocal(source, paths.home) : fetched.get(sid);
    if (fresh) {
      const shipped = fresh.skills.map((s) => s.original).sort();
      const twice = shipped.filter((o, i) => shipped.indexOf(o) !== i);
      if (twice.length) problems.push(`sources.${sid}: more than one folder is named ${[...new Set(twice)].join(", ")}`);
      const prev = lock.sources[sid];
      // Without `pick`, the first install takes everything; after that a
      // skill a vendor adds is only offered, never installed unreviewed. A
      // local folder is yours: a new folder there is the request to install.
      const installed = new Set(Object.keys(lock.skills).filter((id) => id.startsWith(`${sid}/`)));
      // `pick` names what to install; a skill outside it that you have not
      // seen is offered too, so an explicit list never hides a new skill.
      const takes = (o: SkillName) =>
        Boolean(opts.accept?.has(skillId(sid, o))) ||
        (source.pick ? source.pick.includes(o) : source.type === "local" || !prev || installed.has(skillId(sid, o)));
      const taken: string[] = [];
      for (const s of fresh.skills) {
        if (source.exclude?.includes(s.original)) continue;
        if (takes(s.original)) {
          add(s.original, putInStore(paths, sid, s.original, s.dir));
          taken.push(s.original);
        } else if (prev && !prev.seen.includes(s.original)) offered.push(skillId(sid, s.original));
      }
      // Seen means shown to you: everything when you were offered the full
      // list, otherwise what was seen before plus what is installed now.
      const seen = opts.offeredNow || !prev ? [...new Set(shipped)] : [...new Set([...prev.seen, ...taken])].sort();
      const repoDirs = fresh.paths ?? prev?.paths;
      if (prev?.resolved !== fresh.resolved || prev.seen.join() !== seen.join() || JSON.stringify(prev.paths) !== JSON.stringify(repoDirs)) {
        lock.sources[sid] = { resolved: fresh.resolved, syncedAt: now, seen, ...(repoDirs ? { paths: repoDirs } : {}) };
      }
      continue;
    }
    for (const [id, entry] of Object.entries(lock.skills) as [SkillId, SkillLock][]) {
      if (!id.startsWith(`${sid}/`)) continue;
      const original = id.slice(sid.length + 1) as SkillName;
      if (!selected(source, original)) continue;
      if (!fs.existsSync(storedAt(paths, sid, original, entry.base))) problems.push(`${id}: its content is missing from the store; run skl update ${sid}`);
      else add(original, entry.base);
    }
  }
  const byName = new Map<string, Want>();
  for (const w of wants) {
    if (!isValidSkillName(w.name)) problems.push(`${w.id} would install as "${w.name}", which is not a valid skill name (a-z, 0-9, single hyphens, at most 64).\n    Fix: ${fixFor(w)}`);
    const other = byName.get(w.name);
    if (other) problems.push(`${other.id} and ${w.id} would both install as "${w.name}".\n    Fix: ${fixFor(w)}`);
    byName.set(w.name, w);
  }
  if (problems.length) throw new Error(`Nothing was changed:\n  ${problems.join("\n  ")}`);
  return { wants, offered };
}

/** The manifest line that would avoid a name clash for `w`. */
function fixFor(w: Want): string {
  return `set sources.${w.source}.prefix, or add sources.${w.source}.rename.${w.original}.`;
}

/**
 * Every installed name against everything skl does not own, before the first
 * move: external skills, folders and links in targets, and skills you edited.
 */
function recheck(paths: Paths, lock: Lock, wants: Want[], held: Map<SkillId, SkillLock>): void {
  const external = externalSkills(paths, lock);
  const kept = new Map([...held].map(([id, s]) => [s.name, id]));
  const problems: string[] = [];
  for (const w of wants) {
    const taken = external.get(w.name);
    if (taken) problems.push(`${w.id} would install as "${w.name}", which is taken by ${describeExternal(taken)}.\n    Fix: ${fixFor(w)}`);
    if (kept.has(w.name)) problems.push(`${w.id} would replace ${w.name}, which you edited (${kept.get(w.name)}).\n    Fix: ${fixFor(w)}`);
    for (const dir of w.dirs) {
      if (foreignInTarget(paths, dir, w.name)) {
        problems.push(`${w.id} would link ${path.join(dir, w.name)}, which skl did not create.\n    Fix: move it away, or ${fixFor(w)}`);
      }
    }
  }
  if (problems.length) throw new Error(`Nothing was changed:\n  ${problems.join("\n  ")}`);
}

/** Sync and save the lock; returns one line per change, none when up to date. */
export function sync(paths: Paths, manifest: Manifest, given: Lock, opts: SyncOptions = {}): SyncChange[] {
  const now = opts.now ?? new Date().toISOString();
  const dry = Boolean(opts.dryRun);
  const lock = dry ? structuredClone(given) : given;
  const before = JSON.stringify(lock);
  const { wants: all, offered } = wanted(paths, manifest, lock, now, opts);
  // A skill you changed in place stays as it is until you say otherwise.
  const held = opts.discardEdits ? new Map<SkillId, SkillLock>() : editedInPlace(paths, lock);
  const wants = all.filter((w) => !held.has(w.id));
  recheck(paths, lock, wants, held);

  const staging = path.join(paths.sklDir, "staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const renames = new Map<SourceId, Map<string, string>>();
  const installedAs = [
    ...wants.map((w) => [w.id, w.name] as const),
    ...[...held].map(([id, s]) => [id, s.name] as const),
  ];
  for (const [id, name] of installedAs) {
    const { source, original } = splitSkillId(id);
    if (!renames.has(source)) renames.set(source, new Map());
    renames.get(source)?.set(original, name);
  }
  const rendered = wants.map((w) => {
    const to = path.join(staging, w.name);
    const { rewrites } = render({
      from: storedAt(paths, w.source, w.original, w.base),
      to,
      source: w.source,
      original: w.original,
      name: w.name,
      renames: renames.get(w.source) ?? new Map(),
    });
    return { ...w, staged: to, output: treeHash(to), rewrites };
  });

  const changes: SyncChange[] = [];
  const trash = trashDir(paths.sklDir, "sync");
  const keep = new Map(wants.map((w) => [w.id, w.name]));
  const wasAt = new Map((Object.entries(lock.skills) as [SkillId, SkillLock][]).map(([id, s]) => [id, s.name]));
  for (const [id, entry] of held) changes.push({ kind: "edited", id, name: entry.name });
  for (const [id, entry] of Object.entries(lock.skills) as [SkillId, SkillLock][]) {
    if (keep.get(id) === entry.name || held.has(id)) continue;
    if (!dry) {
      moveToTrash(trash, path.join(paths.skillsDir, entry.name));
      unlink(paths, entry.name);
    }
    delete lock.skills[id];
    if (!keep.has(id)) changes.push({ kind: "remove", id, name: entry.name });
  }
  for (const sid of Object.keys(lock.sources) as SourceId[]) {
    if (!manifest.sources[sid]) delete lock.sources[sid];
  }

  if (!dry) fs.mkdirSync(paths.skillsDir, { recursive: true });
  for (const r of rendered) {
    const dest = path.join(paths.skillsDir, r.name);
    // A name that moved (a new prefix) was trashed above in a real run; in
    // a dry run it is still there, so judge by where the skill was.
    const moved = wasAt.has(r.id) && wasAt.get(r.id) !== r.name;
    const written = moved || !fs.existsSync(dest) || treeHash(dest) !== r.output;
    const relinked = !written && !linksMatch(paths, r.name, r.dirs);
    if (!dry) {
      if (written) {
        moveToTrash(trash, dest);
        fs.renameSync(r.staged, dest);
      }
      link(paths, r.name, r.dirs);
    }
    if (written) changes.push({ kind: "install", id: r.id, name: r.name, replaced: wasAt.get(r.id) === r.name, rewrites: r.rewrites });
    else if (relinked) changes.push({ kind: "relink", id: r.id, name: r.name });
    const prev = lock.skills[r.id];
    lock.skills[r.id] = { name: r.name, base: r.base, output: r.output, updatedAt: written || !prev ? now : prev.updatedAt };
  }
  fs.rmSync(staging, { recursive: true, force: true });
  if (!dry && JSON.stringify(lock) !== before) writeLock(paths.lockFile, lock);
  return [...changes, ...offered.map((id) => ({ kind: "offered" as const, id }))];
}

/** One line per rewritten reference; repeats on the same line are counted, not listed. */
function describe(rewrites: Rewrite[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rewrites) {
    const line = `  ${r.file}:${r.change.line}: \`${r.change.from}\` -> \`${r.change.to}\``;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts].map(([line, n]) => (n > 1 ? `${line} (×${n})` : line));
}
