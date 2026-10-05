import fs from "node:fs";
import path from "node:path";
import type { Plan } from "./plan.ts";
import type { Paths, Registry } from "./registry.ts";
import { type State, writeState } from "./state.ts";

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

export function link(paths: Paths, name: string): void {
  const target = path.join(paths.skillsDir, name);
  for (const dir of paths.links) {
    const at = path.join(dir, name);
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.lstatSync(at, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) fs.unlinkSync(at);
    else if (st) throw new Error(`${at} exists and is not a symlink; refusing to replace it.`);
    fs.symlinkSync(target, at);
  }
}

/** Remove our symlinks only: ones that point at our copy of `name`. */
export function unlink(paths: Paths, name: string): void {
  const target = path.join(paths.skillsDir, name);
  for (const dir of paths.links) {
    const at = path.join(dir, name);
    const st = fs.lstatSync(at, { throwIfNoEntry: false });
    if (st?.isSymbolicLink() && path.resolve(dir, fs.readlinkSync(at)) === target) fs.unlinkSync(at);
  }
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
  const trash = trashDir(paths, p.set);
  fs.mkdirSync(paths.skillsDir, { recursive: true });

  for (const name of p.removed) {
    moveToTrash(trash, path.join(paths.skillsDir, name));
    unlink(paths, name);
  }
  const now = new Date().toISOString();
  const prev = state.sets[p.set]?.skills ?? {};
  const skills: State["sets"][string]["skills"] = {};
  for (const s of p.skills) {
    const dest = path.join(paths.skillsDir, s.name);
    if (s.write) {
      moveToTrash(trash, dest);
      fs.renameSync(s.staged, dest);
    }
    link(paths, s.name);
    skills[s.name] = {
      ...(s.original !== s.name ? { original: s.original } : {}),
      hash: s.hash,
      installed: s.installed,
      updatedAt: s.write || !prev[s.name] ? now : prev[s.name].updatedAt,
    };
  }
  state.sets[p.set] = { syncedAt: now, skills };
  writeState(paths.stateDir, state);

  if (p.captured) {
    const set = registry.sets[p.set];
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
  const names = Object.keys(state.sets[setId]?.skills ?? {});
  const trash = trashDir(paths, `removed-${setId}`);
  for (const name of names) {
    moveToTrash(trash, path.join(paths.skillsDir, name));
    unlink(paths, name);
  }
  delete state.sets[setId];
  writeState(paths.stateDir, state);
  return names;
}
