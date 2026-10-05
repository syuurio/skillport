import fs from "node:fs";
import path from "node:path";
import { listSkillDirs, pinnedPackage } from "./acquire.ts";
import { isOursOrFree } from "./apply.ts";
import type { ManagedSet, Paths, RenameRule } from "./registry.ts";
import type { InstalledSkill, LockEntry, State } from "./state.ts";
import {
  type Change,
  isValidSkillName,
  localDate,
  readFrontmatterName,
  rewriteReferences,
  setFrontmatterName,
} from "./transform.ts";
import { treeHash } from "./treehash.ts";

export type Upstream = "new" | "changed" | "unchanged";

/** Reason recorded for a rename you chose inside the vendor's installer. */
export const RENAMED_IN_INSTALLER = "renamed in installer";

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

/** What already holds a name. */
export type HolderKind =
  | "twin" // another skill of the same set
  | "set" // a skill skillport installed for another set
  | "lock" // a skill npx skills installed
  | "unowned" // a folder in ~/.agents/skills nobody owns
  | "link"; // something at the link path that skillport did not create

export interface Collision {
  original: string;
  name: string;
  kind: HolderKind;
  /** Set id for "set", npx skills source for "lock". */
  holderId?: string;
  /** Who already holds the name, for people. */
  holder: string;
}

export interface Plan {
  setId: string;
  /** Pinned installer or package, recorded in state. */
  source?: string;
  /** Folders the skills are linked into. */
  links: string[];
  /** Some link is missing, or one of ours sits in a folder no longer chosen. */
  relink: boolean;
  /** Adopt: unmanaged folders in skillsDir that match and become ours as they are. */
  adopted: string[];
  /** Adopt: identical copies in agent folders, moved to trash on apply. */
  strays: string[];
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
  /** Folders this set's skills are linked into. */
  links: string[];
  /** The installer ran interactively; read selection and renames from it. */
  fromInteractiveRun: boolean;
  /**
   * Take over identical copies already on disk instead of calling them
   * collisions: every skill (`skl adopt`), or only the named ones (chosen in
   * the collision prompt).
   */
  adopt?: boolean | string[];
  today?: string;
}

export function plan(input: PlanInput): Plan {
  const { paths, setId, set, state, vendorDir, staging } = input;
  const prev = state.sets[setId]?.skills ?? {};
  const today = input.today ?? localDate();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Vendor content is untrusted. Anything but regular files and folders is
  // refused before a single byte is read: a symlink could pull any file on
  // this machine into a skill every agent reads, and a FIFO would block the
  // read forever.
  const vendor = listSkillDirs(vendorDir).flatMap((dir) => {
    const odd = irregularEntries(dir);
    if (odd.length) {
      errors.push(`${path.basename(dir)} contains entries skillport does not install (only regular files and folders): ${odd.join(", ")}`);
      return [];
    }
    const fm = readFrontmatterName(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).name;
    return [{ dir, original: fm ?? path.basename(dir), folder: path.basename(dir) }];
  });
  if (vendor.length === 0 && errors.length === 0) errors.push(`No skills found in ${vendorDir}.`);

  // An interactive run is the selection; otherwise the registry is.
  const rename: Record<string, RenameRule> = { ...(set.rename ?? {}) };
  let captured: Plan["captured"];
  if (input.fromInteractiveRun) {
    for (const v of vendor) {
      if (v.folder !== v.original) {
        rename[v.original] = { to: v.folder, reason: RENAMED_IN_INSTALLER, at: today };
      }
    }
    captured = {
      skills: vendor.map((v) => v.original).sort(),
      rename: Object.fromEntries(Object.entries(rename).filter(([k]) => vendor.some((v) => v.original === k))),
    };
  }
  const allow = input.fromInteractiveRun ? null : set.skills ? new Set(set.skills) : null;
  const excluded = new Set(set.exclude ?? []);
  const selected = vendor.filter((v) => !excluded.has(v.original) && (!allow || allow.has(v.original)));
  const unselected = vendor
    .filter((v) => allow && !allow.has(v.original) && !excluded.has(v.original))
    .map((v) => v.original);

  const nameOf = (original: string) => rename[original]?.to ?? original;

  // A name becomes a path segment; reject it before anything is written.
  const safe = selected.filter((v) => {
    const name = nameOf(v.original);
    if (isValidSkillName(name)) return true;
    errors.push(`"${name}" is not a valid skill name (a-z, 0-9, single -).`);
    return false;
  });
  const renames = new Map(
    safe.filter((v) => nameOf(v.original) !== v.original).map((v) => [v.original, nameOf(v.original)]),
  );

  // Stage every selected skill fully transformed; whether it is swapped in is
  // decided by comparing hashes, so a new rename also rewrites unchanged
  // skills that refer to it.
  const out = path.join(staging, "out");
  fs.rmSync(out, { recursive: true, force: true });
  const rewrites: Plan["rewrites"] = [];
  const keptAsCode: Plan["keptAsCode"] = [];
  const skills: SkillPlan[] = safe.map((v) => {
    const name = nameOf(v.original);
    const hash = treeHash(v.dir);
    const dest = path.join(out, name);
    fs.cpSync(v.dir, dest, { recursive: true });
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
      // Your edits are kept unless there is something new to write: a vendor
      // change, a new rename, or anything else that changes our copy.
      write: diskHash !== installed && !(prevInstalled === installed && diskHash !== null),
      localEdits: diskHash !== null && prevInstalled !== undefined && diskHash !== prevInstalled,
      staged: dest,
    };
  });

  const keep = new Set(skills.map((s) => s.name));
  // State is our own file, but its keys become paths too.
  const removed = Object.keys(prev).filter((n) => !keep.has(n) && isValidSkillName(n));
  for (const n of Object.keys(prev)) {
    if (!isValidSkillName(n)) errors.push(`state.json has an invalid skill name "${n}"; fix or remove it by hand.`);
  }

  const adoption = { adopted: [] as string[], strays: [] as string[] };
  const collisions = findCollisions(input, skills, prev, adoption);
  for (const s of skills) {
    const plugin = input.pluginSkills.get(s.name);
    if (plugin) warnings.push(`"${s.name}" also exists as plugin skill ${plugin}:${s.name} (namespaced, no conflict).`);
  }

  const relink = skills.some((s) => {
    const dest = path.join(paths.skillsDir, s.name);
    return paths.links.some((dir) => {
      const at = path.join(dir, s.name);
      const present = Boolean(fs.lstatSync(at, { throwIfNoEntry: false })) && isOursOrFree(at, dest);
      return input.links.includes(dir) ? !present : present;
    });
  });

  const pin = pinnedPackage(set);
  return { setId, source: pin ? `${pin.name}@${pin.version}` : undefined, links: input.links, relink, ...adoption, skills, removed, unselected, collisions, warnings, errors, rewrites, keptAsCode, captured };
}

/**
 * Who, other than `setId`, owns a skill name: a skillport set (from state) or
 * npx skills (from its lock). Shared by both kinds of plan so their answers
 * cannot drift apart.
 */
export function ownerOf(
  name: string,
  setId: string | undefined,
  state: State,
  lock: Record<string, LockEntry>,
): { kind: "set" | "lock"; holderId: string; holder: string } | null {
  const other = Object.entries(state.sets).find(([id, st]) => id !== setId && name in st.skills);
  if (other) return { kind: "set", holderId: other[0], holder: `set "${other[0]}"` };
  const entry = lock[name];
  if (entry) return { kind: "lock", holderId: entry.source, holder: `npx skills (${entry.source})` };
  return null;
}

function findCollisions(
  input: PlanInput,
  skills: SkillPlan[],
  prev: Record<string, InstalledSkill>,
  adoption: { adopted: string[]; strays: string[] },
): Collision[] {
  const { paths, setId, state, lock } = input;
  const found: Collision[] = [];
  const seen = new Map<string, string>();
  for (const s of skills) {
    const add = (kind: HolderKind, holder: string, holderId?: string) =>
      found.push({ original: s.original, name: s.name, kind, holder, ...(holderId ? { holderId } : {}) });
    const twin = seen.get(s.name);
    if (twin) {
      add("twin", `${setId}/${twin}`);
      continue;
    }
    seen.set(s.name, s.original);
    const owner = ownerOf(s.name, setId, state, lock);
    if (owner) {
      add(owner.kind, owner.holder, owner.holderId);
      continue;
    }
    const dest = path.join(paths.skillsDir, s.name);
    // Adopting: a copy identical to what skillport would install is the same
    // skill a vendor already put there, not a conflict.
    const adopting = input.adopt === true || (Array.isArray(input.adopt) && input.adopt.includes(s.name));
    const identical = (at: string) => {
      if (!adopting) return false;
      const st = fs.lstatSync(at, { throwIfNoEntry: false });
      return Boolean(st?.isDirectory()) && [s.installed, s.hash].includes(treeHash(at));
    };
    // lstat: a dangling symlink (your own skill, moved for now) is occupied.
    if (fs.lstatSync(dest, { throwIfNoEntry: false }) && !(s.name in prev)) {
      if (identical(dest)) adoption.adopted.push(s.name);
      else {
        add("unowned", `an unmanaged folder ${dest}${adopting ? " with different content" : ""}`);
        continue;
      }
    }
    for (const dir of new Set([...input.links, ...(adopting ? paths.agentDirs : [])])) {
      const at = path.join(dir, s.name);
      if (isOursOrFree(at, dest)) continue;
      if (identical(at)) adoption.strays.push(at);
      else if (input.links.includes(dir)) {
        add("link", `${at}, which skillport did not create`);
        break;
      }
    }
  }
  return found;
}

/** Entries that are not regular files or folders, the skill folder included. */
function irregularEntries(dir: string): string[] {
  if (!fs.lstatSync(dir).isDirectory()) return ["."];
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => !e.isFile() && !e.isDirectory())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)));
}

function markdownFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(e.parentPath, e.name));
}
