import fs from "node:fs";
import path from "node:path";
import type { Paths } from "./paths.ts";
import { isValidSkillName } from "./transform.ts";

// Moving things into place. Every replaced or removed folder goes to the
// trash, never `rm`, so any apply can be undone by hand.

export function trashDir(stateDir: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const at = path.join(stateDir, "trash", `${stamp}-${label}`);
  // Two runs in the same millisecond must not share a folder: a second
  // move of the same name would land on the first.
  let n = 1;
  while (fs.existsSync(n === 1 ? at : `${at}-${n}`)) n++;
  return n === 1 ? at : `${at}-${n}`;
}

/**
 * Move `from` into the trash folder, at `rel` (its name by default). The one
 * way skillport ever takes something away; a no-op when nothing is there.
 */
export function moveToTrash(trash: string, from: string, rel = path.basename(from)): void {
  if (!fs.lstatSync(from, { throwIfNoEntry: false })) return;
  const to = path.join(trash, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  fs.renameSync(from, to);
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
 * One skillport run at a time: runs share staging and state. The lock is a
 * directory (mkdir is atomic) holding the owner's pid. A lock whose process
 * is gone is taken over by renaming it aside first, so of two runs that both
 * see it stale, only one wins the rename.
 *
 * The state folder is made private (0700): staging holds the installer's fake
 * HOME, where an installer may write your token.
 */
export function acquireLock(stateDir: string): () => void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const dir = path.join(stateDir, "lock.d");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
      removeDeadLocks(stateDir);
      return () => fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // The lock folder's identity, taken before its pid is read: a takeover
    // must move the folder that was judged, not a fresh lock another run
    // made in the meantime.
    const seenAt = fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs;
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
    } catch {
      // The owner is between mkdir and writing its pid, or just released.
    }
    if (pid && isAlive(pid)) throw new Error(`Another skillport run (pid ${pid}) is in progress.`);
    if (!pid) {
      // Its owner is between mkdir and writing the pid, or died there. Give a
      // fresh one a moment; an old one is stale.
      const age = Date.now() - (seenAt ?? Date.now());
      if (age < 10_000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        continue;
      }
    }
    const aside = `${dir}.stale-${process.pid}-${attempt}`;
    try {
      fs.renameSync(dir, aside);
    } catch {
      continue; // someone else moved it first
    }
    // Between reading the dead pid and the rename, another run may have
    // taken the lock over and written its own pid. Then what we moved is a
    // live lock: put it back and let that run keep it.
    let moved = 0;
    try {
      moved = Number(fs.readFileSync(path.join(aside, "pid"), "utf8"));
    } catch {
      // empty lock folder: treat as the stale one
    }
    const movedAt = fs.statSync(aside, { throwIfNoEntry: false })?.mtimeMs;
    if ((moved && moved !== pid) || movedAt !== seenAt) {
      try {
        fs.renameSync(aside, dir);
      } catch {
        // A third run made a new lock meanwhile. Keep the moved one aside
        // rather than delete a live run's lock; it is cleaned up later.
      }
      if (!moved) continue; // a fresh lock without its pid yet: try again
      throw new Error(`Another skillport run (pid ${moved}) is in progress.`);
    }
    fs.rmSync(aside, { recursive: true, force: true });
  }
  throw new Error(`Could not take the lock in ${stateDir}.`);
}

/** Locks a takeover set aside (lock.d.stale-*) whose owner is gone. */
function removeDeadLocks(stateDir: string): void {
  for (const name of fs.readdirSync(stateDir)) {
    if (!name.startsWith("lock.d.stale-")) continue;
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(path.join(stateDir, name, "pid"), "utf8"));
    } catch {
      // no pid file: nothing alive owns it
    }
    if (!pid || !isAlive(pid)) fs.rmSync(path.join(stateDir, name), { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
