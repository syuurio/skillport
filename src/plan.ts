import fs from "node:fs";
import path from "node:path";
import { listSkillDirs } from "./acquire.ts";
import type { ManagedSet, Paths, RenameRule } from "./registry.ts";
import type { LockEntry, State } from "./state.ts";
import {
  type Change,
  isValidSkillName,
  readFrontmatterName,
  rewriteReferences,
  setFrontmatterName,
} from "./transform.ts";
import { treeHash } from "./treehash.ts";

export type Upstream = "new" | "changed" | "unchanged";

export interface SkillPlan {
  original: string;
  name: string;
  upstream: Upstream;
  /** Vendor content hash (before rename). */
  hash: string;
  /** Hash of the transformed copy in staging. */
  installed: string;
  /** Staged copy differs from what is on disk, so it will be swapped in. */
  write: boolean;
  /** On-disk copy no longer matches what skillport wrote last time. */
  localEdits: boolean;
  staged: string;
}

export interface Collision {
  original: string;
  name: string;
  /** Who already holds the name. */
  holder: string;
}

export interface Plan {
  set: string;
  skills: SkillPlan[];
  /** Installed by this set before, gone or deselected now. */
  removed: string[];
  /** Shipped by the vendor but not in the set's `skills` list. */
  unselected: string[];
  collisions: Collision[];
  warnings: string[];
  errors: string[];
  rewrites: { file: string; change: Change }[];
  keptAsCode: { file: string; change: Change }[];
  /** Interactive run: selection and in-installer renames to save. */
  captured?: { skills: string[]; rename: Record<string, RenameRule> };
}

export interface PlanInput {
  paths: Paths;
  setId: string;
  set: ManagedSet;
  state: State;
  lock: Record<string, LockEntry>;
  /** Names of skills shipped by Claude Code plugins, for warnings. */
  pluginSkills: Map<string, string>;
  vendorDir: string;
  staging: string;
  /** The installer ran interactively; read selection and renames from it. */
  captured: boolean;
  today?: string;
}

export function plan(input: PlanInput): Plan {
  const { paths, setId, set, state, lock, vendorDir, staging } = input;
  const prev = state.sets[setId]?.skills ?? {};
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const errors: string[] = [];
  const warnings: string[] = [];

  const vendor = listSkillDirs(vendorDir).map((dir) => {
    const fm = readFrontmatterName(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).name;
    return { dir, original: fm ?? path.basename(dir), folder: path.basename(dir) };
  });
  if (vendor.length === 0) errors.push(`No skills found in ${vendorDir}.`);

  // An interactive run is the selection; otherwise the registry is.
  const rename: Record<string, RenameRule> = { ...(set.rename ?? {}) };
  let captured: Plan["captured"];
  if (input.captured) {
    for (const v of vendor) {
      if (v.folder !== v.original) {
        rename[v.original] = { to: v.folder, reason: "renamed in installer", at: today };
      }
    }
    captured = {
      skills: vendor.map((v) => v.original).sort(),
      rename: Object.fromEntries(Object.entries(rename).filter(([k]) => vendor.some((v) => v.original === k))),
    };
  }
  const allow = input.captured ? null : set.skills ? new Set(set.skills) : null;
  const excluded = new Set(set.exclude ?? []);
  const selected = vendor.filter((v) => !excluded.has(v.original) && (!allow || allow.has(v.original)));
  const unselected = vendor
    .filter((v) => allow && !allow.has(v.original) && !excluded.has(v.original))
    .map((v) => v.original);

  const nameOf = (original: string) => rename[original]?.to ?? original;
  const renames = new Map(
    selected.filter((v) => nameOf(v.original) !== v.original).map((v) => [v.original, nameOf(v.original)]),
  );

  // Stage every selected skill fully transformed; whether it is swapped in is
  // decided by comparing hashes, so a new rename also rewrites unchanged
  // skills that refer to it.
  const out = path.join(staging, "out");
  fs.rmSync(out, { recursive: true, force: true });
  const rewrites: Plan["rewrites"] = [];
  const keptAsCode: Plan["keptAsCode"] = [];
  const skills: SkillPlan[] = selected.map((v) => {
    const name = nameOf(v.original);
    const hash = treeHash(v.dir);
    const dest = path.join(out, name);
    fs.cpSync(v.dir, dest, { recursive: true, dereference: true });
    if (name !== v.original || v.folder !== v.original) {
      const skillMd = path.join(dest, "SKILL.md");
      fs.writeFileSync(skillMd, setFrontmatterName(fs.readFileSync(skillMd, "utf8"), name));
    }
    if (renames.size) {
      for (const file of markdownFiles(dest)) {
        const r = rewriteReferences(fs.readFileSync(file, "utf8"), renames);
        const rel = path.relative(out, file);
        r.changes.forEach((change) => rewrites.push({ file: rel, change }));
        r.skipped.forEach((change) => keptAsCode.push({ file: rel, change }));
        if (r.changes.length) fs.writeFileSync(file, r.text);
      }
    }
    const installed = treeHash(dest);
    const before = Object.entries(prev).find(([n, s]) => (s.original ?? n) === v.original);
    const upstream: Upstream = !before ? "new" : before[1].hash === hash ? "unchanged" : "changed";
    const onDisk = path.join(paths.skillsDir, name);
    const diskHash = fs.existsSync(onDisk) ? treeHash(onDisk) : null;
    const prevInstalled = prev[name]?.installed;
    return {
      original: v.original,
      name,
      upstream,
      hash,
      installed,
      write: diskHash !== installed,
      localEdits: diskHash !== null && prevInstalled !== undefined && diskHash !== prevInstalled,
      staged: dest,
    };
  });

  const keep = new Set(skills.map((s) => s.name));
  const removed = Object.keys(prev).filter((n) => !keep.has(n));

  for (const s of skills) {
    if (!isValidSkillName(s.name)) errors.push(`"${s.name}" is not a valid skill name (a-z, 0-9, single -).`);
  }
  const collisions = findCollisions(input, skills, prev);
  for (const s of skills) {
    const plugin = input.pluginSkills.get(s.name);
    if (plugin) warnings.push(`"${s.name}" also exists as plugin skill ${plugin}:${s.name} (namespaced, no conflict).`);
  }

  return { set: setId, skills, removed, unselected, collisions, warnings, errors, rewrites, keptAsCode, captured };
}

function findCollisions(
  input: PlanInput,
  skills: SkillPlan[],
  prev: Record<string, unknown>,
): Collision[] {
  const { paths, setId, state, lock } = input;
  const found: Collision[] = [];
  const seen = new Map<string, string>();
  for (const s of skills) {
    const add = (holder: string) => found.push({ original: s.original, name: s.name, holder });
    const twin = seen.get(s.name);
    if (twin) {
      add(`${setId}/${twin}`);
      continue;
    }
    seen.set(s.name, s.original);
    const otherSet = Object.entries(state.sets).find(([id, st]) => id !== setId && s.name in st.skills);
    if (otherSet) {
      add(`set "${otherSet[0]}"`);
      continue;
    }
    if (lock[s.name]) {
      add(`npx skills (${lock[s.name].source})`);
      continue;
    }
    const dest = path.join(paths.skillsDir, s.name);
    if (fs.existsSync(dest) && !(s.name in prev)) {
      add(`an unmanaged folder ${dest}`);
      continue;
    }
    for (const linkDir of paths.links) {
      const link = path.join(linkDir, s.name);
      const st = fs.lstatSync(link, { throwIfNoEntry: false });
      if (st && !(st.isSymbolicLink() && path.resolve(linkDir, fs.readlinkSync(link)) === dest)) {
        add(`${link}, which skillport did not create`);
        break;
      }
    }
  }
  return found;
}

function markdownFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(e.parentPath, e.name));
}
