import fs from "node:fs";
import path from "node:path";
import type { Fetched } from "./adapters/index.ts";
import { fetchLocal } from "./adapters/local.ts";
import { isOursOrFree, link, moveToTrash, trashDir, unlink } from "./apply.ts";
import { describeExternal, externalSkills, foreignInTarget } from "./external.ts";
import { type Lock, type SkillLock, writeLock } from "./lock.ts";
import { type Manifest, type SkillId, type SkillName, type Source, type SourceId, installedName, skillId, splitSkillId } from "./manifest.ts";
import { type MergeInfo, applyPatch, applyPatchPartly, diffTrees, mergeDir, mergeTrees, patchFiles, patchHash, readMergeInfo, removeMerge } from "./patch.ts";
import { DEFAULT_LINKS, type Paths } from "./paths.ts";
import { home } from "./report.ts";
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

/** A source `skl add` is adding, and the command line you ran, to repeat in a fix. */
export interface Adding {
  id: SourceId;
  command?: string;
}

export interface SyncOptions {
  /** The source `skl add` is adding, so a name clash points at that command. */
  adding?: Adding;
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
  /** Dry runs only: leave each folder sync would write here, by installed name. */
  keep?: string;
}

export type SyncChange =
  | { kind: "install"; id: SkillId; name: string; replaced: boolean; rewrites: Rewrite[]; reapplied?: boolean }
  | { kind: "relink"; id: SkillId; name: string }
  | { kind: "remove"; id: SkillId; name: string }
  | { kind: "edited"; id: SkillId; name: string }
  | { kind: "conflict"; id: SkillId; name: string; reason: string; files: string[]; dir: string }
  | { kind: "offered"; id: SkillId }
  | { kind: "blocked"; id: SkillId; name: string; why: string; fix: string };

/** Why a skill cannot have its name, and the command that gives it another. */
export interface Clash {
  why: string;
  fix: string;
}

const clashLine = (w: Want, c: Clash) => `${w.id} would install as "${w.name}", ${c.why}.\n    rename it: ${c.fix}`;

/**
 * Vendor sources sync cannot install: nothing fetched yet (a new machine
 * with only ~/.config/skl), so their content is not in the store.
 */
export function neverFetched(manifest: Manifest, lock: Lock): SourceId[] {
  return (Object.entries(manifest.sources) as [SourceId, Source][]).filter(([sid, s]) => s.type !== "local" && !lock.sources[sid]).map(([sid]) => sid);
}

/** The lines `skl sync` prints for its changes. */
export function describeSync(changes: SyncChange[]): string[] {
  return changes.flatMap((c) => {
    switch (c.kind) {
      case "install":
        return [`${c.id} -> ${c.name}${c.reapplied ? " (patch reapplied)" : ""}`, ...describe(c.rewrites)];
      case "relink":
        return [`${c.id} -> ${c.name}`];
      case "remove":
        return [`removed ${c.name} (${c.id})`];
      case "edited":
        return [`edited ${c.name} (${c.id}) was changed in place; kept as is`, "  to replace it with skl's version: skl sync --discard-edits"];
      case "conflict":
        return [`conflict ${c.name} (${c.id}): ${c.reason}; held back`, `  resolve in ${home(c.dir)}, then: skl edit ${c.id}`];
      case "blocked":
        return [`blocked ${c.name} (${c.id}): ${c.why}`, `  rename it: ${c.fix}`];
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
function wanted(
  paths: Paths,
  manifest: Manifest,
  lock: Lock,
  now: string,
  opts: SyncOptions,
  established: ReadonlySet<string>,
): { wants: Want[]; offered: SkillId[]; clashes: Map<SkillId, Clash> } {
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
  // A skill a source you already have adds upstream is only held back, so
  // one new name cannot stop every other update; any other clash comes from
  // the manifest or a source being added, and stops all.
  const newcomer = (w: Want) => !lock.skills[w.id] && established.has(w.source);
  const byName = new Map<string, Want>();
  const clashes = new Map<SkillId, Clash>();
  for (const w of wants) {
    if (!isValidSkillName(w.name)) problems.push(clashLine(w, { why: "which is not a valid skill name (a-z, 0-9, single hyphens, at most 64)", fix: fixFor(w, opts.adding) }));
    const other = byName.get(w.name);
    if (!other) {
      byName.set(w.name, w);
      continue;
    }
    const held = [other, w].filter(newcomer);
    if (!held.length) problems.push(clashLine(w, { why: `taken by ${other.id}`, fix: fixFor(w, opts.adding) }));
    for (const n of held) clashes.set(n.id, { why: `taken by ${(n === w ? other : w).id}`, fix: fixFor(n, opts.adding) });
    if (held.includes(other) && !held.includes(w)) byName.set(w.name, w);
  }
  if (problems.length) throw new Error(`Nothing was changed:\n  ${problems.join("\n  ")}`);
  return { wants, offered, clashes };
}

/** The command that gives `w` a name of its own: `skl rename`, or for the source being added, its `skl add` again. */
function fixFor(w: Want, adding: Adding | undefined): string {
  if (w.source !== adding?.id) return renameCommand(w.id, w.name);
  return `${adding.command ?? `skl add ${w.source} …`} --rename ${w.original}=${newName(w.id, w.name)}`;
}

/** `<source>-<skill>` when that is a different, valid name. */
function newName(id: SkillId, name: string): string {
  const { source, original } = splitSkillId(id);
  const own = `${source}-${original}`;
  return own !== name && isValidSkillName(own) ? own : "<new-name>";
}

/** The `skl rename` that moves `id` off `name`, a name taken elsewhere. */
export const renameCommand = (id: SkillId, name: string) => `skl rename ${id} ${newName(id, name)}`;

/**
 * Every installed name against everything skl does not own, before the first
 * move: external skills, folders and links in targets, and skills you edited.
 * A new skill of a source already installed is only held back, so one new
 * upstream skill cannot stop every other update; returns those with the
 * reason. Anything else stops all: a clash for an installed skill comes from
 * a manifest change you made, and a source you are adding installs whole.
 */
function recheck(
  paths: Paths,
  lock: Lock,
  wants: Want[],
  held: Map<SkillId, SkillLock>,
  established: ReadonlySet<string>,
  adding: Adding | undefined,
): Map<SkillId, Clash> {
  const external = externalSkills(paths, lock);
  const kept = new Map([...held].map(([id, s]) => [s.name, id]));
  const problems: string[] = [];
  const blocked = new Map<SkillId, Clash>();
  for (const w of wants) {
    const why: string[] = [];
    const taken = external.get(w.name);
    if (taken) why.push(`taken by ${describeExternal(taken)}`);
    if (kept.has(w.name)) why.push(`taken by ${kept.get(w.name)}, which you changed in place`);
    for (const dir of w.dirs) {
      if (foreignInTarget(paths, dir, w.name)) why.push(`but ${home(path.join(dir, w.name))} is in the way and skl did not create it (move it away, or rename this skill)`);
    }
    if (!why.length) continue;
    const clash = { why: why.join("; "), fix: fixFor(w, adding) };
    if (lock.skills[w.id] || !established.has(w.source)) problems.push(clashLine(w, clash));
    else blocked.set(w.id, clash);
  }
  if (problems.length) throw new Error(`Nothing was changed:\n  ${problems.join("\n  ")}`);
  return blocked;
}

/** The folder to render: the vendor's, or with your patch applied (merged first when upstream moved). */
type Prepared = { from: string; patch?: string; reapplied?: boolean };
type Conflict = { reason: string; files: string[]; info: MergeInfo; dirs: Record<string, string>; patch: string };

function prepare(paths: Paths, lock: Lock, w: Want, staging: string): Prepared | Conflict {
  const upstream = storedAt(paths, w.source, w.original, w.base);
  const file = patchFiles(paths, w.source, w.original).patch;
  if (!fs.existsSync(file)) return { from: upstream };
  const patch = fs.readFileSync(file, "utf8");
  // The patch was made against the base skl last installed.
  const was = lock.skills[w.id]?.base ?? w.base;
  const base = storedAt(paths, w.source, w.original, was);
  const info = { base: was, upstream: w.base };
  const work = path.join(staging, ".patched", w.source, w.original);
  const yours = path.join(work, "YOURS");
  fs.cpSync(base, yours, { recursive: true });
  try {
    applyPatch(yours, patch);
  } catch {
    // MERGED gets every hunk that still fits; the rest wait in .rej files.
    const merged = path.join(work, "MERGED");
    fs.cpSync(upstream, merged, { recursive: true });
    let rejected: string[] = [];
    try {
      rejected = applyPatchPartly(merged, patch);
    } catch {
      // A patch skl refuses to apply at all leaves MERGED as upstream.
    }
    const reason = "your patch no longer applies to upstream";
    return { reason, files: rejected, info, dirs: { UPSTREAM: upstream, MERGED: merged }, patch };
  }
  if (was === w.base) return { from: yours, patch };
  const merged = path.join(work, "MERGED");
  const files = mergeTrees(base, yours, upstream, merged);
  if (files.length) return { reason: "you and upstream changed the same lines", files, info, dirs: { BASE: base, YOURS: yours, UPSTREAM: upstream, MERGED: merged }, patch };
  return { from: merged, patch: diffTrees(upstream, merged), reapplied: true };
}

/** Lay a conflict out for you or an agent; one already there for the same pair of versions is left alone. */
function fillMerge(paths: Paths, w: Want, c: Conflict): void {
  const dir = mergeDir(paths, w.source, w.original);
  const had = readMergeInfo(dir);
  if (had?.base === c.info.base && had.upstream === c.info.upstream) return;
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, from] of Object.entries(c.dirs)) fs.cpSync(from, path.join(dir, name), { recursive: true });
  const note = patchFiles(paths, w.source, w.original).note;
  if (fs.existsSync(note)) fs.copyFileSync(note, path.join(dir, "note.md"));
  fs.writeFileSync(path.join(dir, "your.patch"), c.patch);
  fs.writeFileSync(path.join(dir, "merge.json"), `${JSON.stringify(c.info, null, 2)}\n`);
}

/** Sync and save the lock; returns one line per change, none when up to date. */
export function sync(paths: Paths, manifest: Manifest, given: Lock, opts: SyncOptions = {}): SyncChange[] {
  const now = opts.now ?? new Date().toISOString();
  const dry = Boolean(opts.dryRun);
  const lock = dry ? structuredClone(given) : given;
  const before = JSON.stringify(lock);
  const established = new Set(Object.keys(lock.sources));
  const { wants: all, offered, clashes } = wanted(paths, manifest, lock, now, opts, established);
  // A skill you changed in place stays as it is until you say otherwise.
  const held = opts.discardEdits ? new Map<SkillId, SkillLock>() : editedInPlace(paths, lock);
  const edited = new Map(held);

  const staging = path.join(paths.sklDir, "staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  // A patch that conflicts holds its skill back like an edit does.
  const prepared = new Map<SkillId, Prepared>();
  const conflicts: SyncChange[] = [];
  for (const w of all.filter((w) => !held.has(w.id))) {
    const p = prepare(paths, lock, w, staging);
    if ("from" in p) {
      prepared.set(w.id, p);
      continue;
    }
    if (!dry) fillMerge(paths, w, p);
    const entry = lock.skills[w.id];
    if (entry) held.set(w.id, entry);
    conflicts.push({ kind: "conflict", id: w.id, name: entry?.name ?? w.name, reason: p.reason, files: p.files, dir: mergeDir(paths, w.source, w.original) });
  }
  const blocked = new Map([...recheck(paths, lock, all.filter((w) => prepared.has(w.id)), held, established, opts.adding), ...clashes]);
  const wants = all.filter((w) => prepared.has(w.id) && !blocked.has(w.id));
  // A blocked skill was not installed, so it is not seen yet: it shows up again until you fix the name.
  for (const id of blocked.keys()) {
    const { source, original } = splitSkillId(id);
    const entry = lock.sources[source];
    if (entry) entry.seen = entry.seen.filter((o) => o !== original);
  }
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
      from: (prepared.get(w.id) as Prepared).from,
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
  for (const [id, entry] of edited) changes.push({ kind: "edited", id, name: entry.name });
  changes.push(...conflicts);
  for (const [id, clash] of blocked) changes.push({ kind: "blocked", id, name: (all.find((w) => w.id === id) as Want).name, ...clash });
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
    const p = prepared.get(r.id) as Prepared;
    if (!dry) {
      // A merged patch is kept against the new upstream; one upstream took in full is done.
      const file = patchFiles(paths, r.source, r.original).patch;
      if (p.reapplied && p.patch) fs.writeFileSync(file, p.patch);
      if (p.reapplied && !p.patch) fs.rmSync(file);
      removeMerge(paths, r.source, r.original);
    }
    if (written) changes.push({ kind: "install", id: r.id, name: r.name, replaced: wasAt.get(r.id) === r.name, rewrites: r.rewrites, ...(p.reapplied ? { reapplied: true } : {}) });
    else if (relinked) changes.push({ kind: "relink", id: r.id, name: r.name });
    const prev = lock.skills[r.id];
    lock.skills[r.id] = {
      name: r.name,
      base: r.base,
      output: r.output,
      ...(p.patch ? { patch: patchHash(p.patch) } : {}),
      updatedAt: written || !prev ? now : prev.updatedAt,
    };
  }
  if (dry && opts.keep) {
    fs.mkdirSync(opts.keep, { recursive: true });
    for (const r of rendered) fs.renameSync(r.staged, path.join(opts.keep, r.name));
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
