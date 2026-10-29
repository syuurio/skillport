import fs from "node:fs";
import path from "node:path";
import type { Fetched } from "./adapters/index.ts";
import { fetchLocal } from "./adapters/local.ts";
import { isOursOrFree, link, moveToTrash, trashDir, unlink } from "./apply.ts";
import { type Lock, type SkillLock, writeLock } from "./lock.ts";
import { type Manifest, type SkillId, type SkillName, type Source, type SourceId, installedName, skillId } from "./manifest.ts";
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

function linkDirs(paths: Paths, manifest: Manifest, source: Source): string[] {
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
}

/** The skills the manifest asks for; stores what was fetched and records it in the lock. */
function wanted(paths: Paths, manifest: Manifest, lock: Lock, now: string, fetched: ReadonlyMap<SourceId, Fetched>): { wants: Want[]; offered: string[] } {
  const wants: Want[] = [];
  const offered: string[] = [];
  const problems: string[] = [];
  for (const [sid, source] of Object.entries(manifest.sources) as [SourceId, Source][]) {
    const dirs = linkDirs(paths, manifest, source);
    const add = (original: SkillName, base: string) =>
      wants.push({ id: skillId(sid, original), source: sid, original, base, name: installedName(sid, original, source), dirs });
    const fresh = source.type === "local" ? fetchLocal(source, paths.home) : fetched.get(sid);
    if (fresh) {
      const seen = fresh.skills.map((s) => s.original).sort();
      const twice = seen.filter((o, i) => seen.indexOf(o) !== i);
      if (twice.length) problems.push(`sources.${sid}: more than one folder is named ${[...new Set(twice)].join(", ")}`);
      const prev = lock.sources[sid];
      // Without `pick`, the first install takes everything; after that a
      // skill upstream adds is only offered, never installed on its own.
      const installed = new Set(Object.keys(lock.skills).filter((id) => id.startsWith(`${sid}/`)));
      const takes = (o: SkillName) => (source.pick ? true : !prev || installed.has(skillId(sid, o)));
      for (const s of fresh.skills) {
        if (!selected(source, s.original)) continue;
        if (takes(s.original)) add(s.original, putInStore(paths, sid, s.original, s.dir));
        else if (!prev?.seen.includes(s.original)) offered.push(`new ${sid}/${s.original} (not installed; skl update ${sid} --pick)`);
      }
      if (prev?.resolved !== fresh.resolved || prev.seen.join() !== seen.join()) {
        lock.sources[sid] = { resolved: fresh.resolved, syncedAt: now, seen };
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
  const byName = new Map<string, SkillId>();
  for (const w of wants) {
    if (!isValidSkillName(w.name)) problems.push(`${w.id}: "${w.name}" is not a valid skill name`);
    const other = byName.get(w.name);
    if (other) problems.push(`${other} and ${w.id} would both be installed as "${w.name}"`);
    byName.set(w.name, w.id);
  }
  if (problems.length) throw new Error(`Nothing was changed:\n  ${problems.join("\n  ")}`);
  return { wants, offered };
}

/** Refuse to replace anything skl did not create, before the first move. */
function recheck(paths: Paths, lock: Lock, wants: Want[]): void {
  const owned = new Set(Object.values(lock.skills).map((s) => s.name));
  const problems: string[] = [];
  for (const w of wants) {
    const dest = path.join(paths.skillsDir, w.name);
    if (fs.lstatSync(dest, { throwIfNoEntry: false }) && !owned.has(w.name)) problems.push(`${dest} exists and was not installed by skl`);
    for (const dir of w.dirs) {
      const at = path.join(dir, w.name);
      if (!isOursOrFree(at, dest)) problems.push(`${at} exists and is not skl's link`);
    }
  }
  if (problems.length) throw new Error(`Nothing was changed:\n  ${problems.join("\n  ")}`);
}

/** Sync and save the lock; returns one line per change, none when up to date. */
export function sync(paths: Paths, manifest: Manifest, lock: Lock, opts: SyncOptions = {}): string[] {
  const now = opts.now ?? new Date().toISOString();
  const before = JSON.stringify(lock);
  const { wants, offered } = wanted(paths, manifest, lock, now, opts.fetched ?? new Map());
  recheck(paths, lock, wants);

  const staging = path.join(paths.sklDir, "staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const renames = new Map<SourceId, Map<string, string>>();
  for (const w of wants) {
    if (!renames.has(w.source)) renames.set(w.source, new Map());
    renames.get(w.source)?.set(w.original, w.name);
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

  const lines: string[] = [];
  const trash = trashDir(paths.sklDir, "sync");
  const keep = new Map(wants.map((w) => [w.id, w.name]));
  for (const [id, entry] of Object.entries(lock.skills) as [SkillId, SkillLock][]) {
    if (keep.get(id) === entry.name) continue;
    moveToTrash(trash, path.join(paths.skillsDir, entry.name));
    unlink(paths, entry.name);
    delete lock.skills[id];
    if (!keep.has(id)) lines.push(`removed ${entry.name} (${id})`);
  }
  for (const sid of Object.keys(lock.sources) as SourceId[]) {
    if (!manifest.sources[sid]) delete lock.sources[sid];
  }

  fs.mkdirSync(paths.skillsDir, { recursive: true });
  for (const r of rendered) {
    const dest = path.join(paths.skillsDir, r.name);
    const written = !fs.existsSync(dest) || treeHash(dest) !== r.output;
    if (written) {
      moveToTrash(trash, dest);
      fs.renameSync(r.staged, dest);
    }
    const relinked = !linksMatch(paths, r.name, r.dirs);
    link(paths, r.name, r.dirs);
    if (written || relinked) lines.push(`${r.id} -> ${r.name}`, ...(written ? r.rewrites.map(describe) : []));
    const prev = lock.skills[r.id];
    lock.skills[r.id] = { name: r.name, base: r.base, output: r.output, updatedAt: written || !prev ? now : prev.updatedAt };
  }
  fs.rmSync(staging, { recursive: true, force: true });
  if (JSON.stringify(lock) !== before) writeLock(paths.lockFile, lock);
  return [...lines, ...offered];
}

const describe = (r: Rewrite) => `  ${r.file}:${r.change.line}: \`${r.change.from}\` -> \`${r.change.to}\``;
