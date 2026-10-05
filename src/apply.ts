import fs from "node:fs";
import path from "node:path";
import type { Plan } from "./plan.ts";
import type { Paths, Registry } from "./registry.ts";
import { type State, writeState } from "./state.ts";
import { isValidSkillName } from "./transform.ts";

// Moving things into place. Every replaced or removed folder goes to the
// trash, never `rm`, so any apply can be undone by hand.

export function trashDir(paths: Paths, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(paths.stateDir, "trash", `${stamp}-${label}`);
}

function moveToTrash(trash: string, from: string): void {
  if (!fs.lstatSync(from, { throwIfNoEntry: false })) return;
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(from, path.join(trash, path.basename(from)));
}

/** Whether `at` is missing, or is a symlink to `target`. Anything else is someone else's. */
export function isOursOrFree(at: string, target: string): boolean {
  const st = fs.lstatSync(at, { throwIfNoEntry: false });
  if (!st) return true;
  return st.isSymbolicLink() && path.resolve(path.dirname(at), fs.readlinkSync(at)) === target;
}

/** Link `name` into `dirs`; drop our links to it from every other known folder. */
export function link(paths: Paths, name: string, dirs: string[]): void {
  const target = path.join(paths.skillsDir, name);
  for (const dir of paths.links.filter((d) => !dirs.includes(d))) {
    const at = path.join(dir, name);
    if (fs.lstatSync(at, { throwIfNoEntry: false }) && isOursOrFree(at, target)) fs.unlinkSync(at);
  }
  for (const dir of dirs) {
    const at = path.join(dir, name);
    if (!isOursOrFree(at, target)) throw new Error(`${at} exists and is not skillport's link; refusing to replace it.`);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.lstatSync(at, { throwIfNoEntry: false })) continue;
    fs.symlinkSync(target, at);
  }
}

/** Remove our symlinks only: ones that point at our copy of `name`. */
export function unlink(paths: Paths, name: string): void {
  const target = path.join(paths.skillsDir, name);
  for (const dir of paths.links) {
    const at = path.join(dir, name);
    if (fs.lstatSync(at, { throwIfNoEntry: false }) && isOursOrFree(at, target)) fs.unlinkSync(at);
  }
}

/**
 * The plan was made before a confirmation prompt that may have sat for a
 * while. Re-check every destination and link before the first move, so a
 * folder or link that appeared meanwhile stops the run instead of being
 * trashed or unlinked, and nothing is left half-applied.
 */
function recheck(paths: Paths, p: Plan, owned: Set<string>): void {
  const problems: string[] = [];
  for (const s of p.skills) {
    const dest = path.join(paths.skillsDir, s.name);
    if (fs.existsSync(dest) && !owned.has(s.name)) problems.push(`${dest} appeared and is not managed by "${p.setId}"`);
    for (const dir of p.links) {
      const at = path.join(dir, s.name);
      if (!isOursOrFree(at, dest)) problems.push(`${at} is not skillport's link`);
    }
  }
  if (problems.length) throw new Error(`Something changed since the plan was made:\n  ${problems.join("\n  ")}`);
}

/**
 * Apply a plan without collisions or errors. Writes the registry too when the
 * plan captured an interactive selection. Returns the trash folder used.
 */
export function apply(
  paths: Paths,
  p: Plan,
  state: State,
  registry: Registry,
  saveRegistry: (r: Registry) => void,
): string {
  if (p.errors.length || p.collisions.length) throw new Error("Refusing to apply a plan with unresolved problems.");
  const prev = state.sets[p.setId]?.skills ?? {};
  const trash = trashDir(paths, p.setId);
  // Adopting: identical copies scattered in agent folders go to the trash
  // first, so the links can take their place.
  for (const at of p.strays) {
    const to = path.join(trash, "strays", path.relative(paths.home, at));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(at, to);
  }
  recheck(paths, p, new Set([...Object.keys(prev), ...p.adopted]));
  fs.mkdirSync(paths.skillsDir, { recursive: true });

  for (const name of p.removed) {
    moveToTrash(trash, path.join(paths.skillsDir, name));
    unlink(paths, name);
  }
  const now = new Date().toISOString();
  const skills: State["sets"][string]["skills"] = {};
  for (const s of p.skills) {
    const dest = path.join(paths.skillsDir, s.name);
    if (s.write) {
      moveToTrash(trash, dest);
      fs.renameSync(s.staged, dest);
    }
    link(paths, s.name, p.links);
    skills[s.name] = {
      ...(s.original !== s.name ? { original: s.original } : {}),
      hash: s.hash,
      installed: s.installed,
      updatedAt: s.write || !prev[s.name] ? now : prev[s.name].updatedAt,
    };
  }
  state.sets[p.setId] = { syncedAt: now, ...(p.source ? { source: p.source } : {}), skills };
  writeState(paths.stateDir, state);

  if (p.captured) {
    const set = registry.sets[p.setId];
    if (set.type !== "skills-cli") {
      set.skills = p.captured.skills;
      if (Object.keys(p.captured.rename).length) set.rename = p.captured.rename;
      else delete set.rename;
      saveRegistry(registry);
    }
  }
  return trash;
}

/** Remove every skill a managed set installed. */
export function removeManaged(paths: Paths, setId: string, state: State): string[] {
  const names = Object.keys(state.sets[setId]?.skills ?? {}).filter(isValidSkillName);
  const trash = trashDir(paths, `removed-${setId}`);
  for (const name of names) {
    moveToTrash(trash, path.join(paths.skillsDir, name));
    unlink(paths, name);
  }
  delete state.sets[setId];
  writeState(paths.stateDir, state);
  return names;
}

/**
 * One skillport run at a time: two runs share staging and state. The lock
 * file holds the pid; a lock whose process is gone is taken over.
 */
export function acquireLock(paths: Paths): () => void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const file = path.join(paths.stateDir, "lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => fs.rmSync(file, { force: true });
    } catch {
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (pid && isAlive(pid)) throw new Error(`Another skillport run (pid ${pid}) is in progress.`);
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not take ${file}.`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
