import fs from "node:fs";
import path from "node:path";
import { isOursOrFree, moveToTrash, trashDir } from "./apply.ts";
import { externalSkills } from "./external.ts";
import type { Lock, SkillLock } from "./lock.ts";
import { type Manifest, type SkillId, splitSkillId } from "./manifest.ts";
import { storedAt } from "./store.ts";
import { linkDirs } from "./sync.ts";
import { type Paths, type Registry, isManaged, linkDirsFor } from "./registry.ts";
import type { LockEntry, State } from "./state.ts";
import { RENAMED_IN_INSTALLER } from "./plan.ts";
import { isValidSkillName } from "./transform.ts";
import { sameSkill, treeHash } from "./treehash.ts";

// `skl doctor`: find what drifted from the registry, state and lock, and fix
// what can be fixed without a judgement call. Everything removed goes to the
// trash; anything that needs a decision is only reported.

export type Kind =
  | "stray-copy"
  | "broken-link"
  | "missing-link"
  | "missing"
  | "collision"
  | "invalid"
  | "edited"
  | "unowned"
  | "stale-rule"
  | "no-note";

export interface Finding {
  kind: Kind;
  message: string;
  /** Present when --fix can resolve it without asking. */
  fix?: () => void;
}

interface Owned {
  name: string;
  /** Where the real folder lives. */
  dest: string;
  /** Hash of what should be on disk, when skillport wrote it. */
  installed?: string;
  /** Hash of the vendor's original, before any rename (skillport sets). */
  vendor?: string;
  /** Folders that should hold our link to it. */
  links: string[];
  owner: string;
  /** The skillport set that owns it; absent for npx skills. */
  setId?: string;
}

/**
 * Every skill some owner claims. Names come from state.json and npx skills'
 * lock, and become path segments below; ones that are not valid skill names
 * are left out here and reported, never joined into a path.
 */
function ownedSkills(
  paths: Paths,
  reg: Registry,
  state: State,
  lock: Record<string, LockEntry>,
  bad: Finding[],
): Owned[] {
  const out: Owned[] = [];
  const valid = (name: string, where: string) => {
    if (isValidSkillName(name)) return true;
    bad.push({ kind: "invalid", message: `${where} lists an invalid skill name ${JSON.stringify(name)}; it is ignored. Fix that file by hand.` });
    return false;
  };
  for (const [id, st] of Object.entries(state.sets)) {
    const set = reg.sets[id];
    const links = set ? linkDirsFor(paths, set) : [];
    for (const [name, s] of Object.entries(st.skills)) {
      if (!valid(name, `state.json (set "${id}")`)) continue;
      out.push({ name, dest: path.join(paths.skillsDir, name), installed: s.installed, vendor: s.hash, links, owner: `set "${id}"`, setId: id });
    }
  }
  // npx skills' skills: the skills-cli set that recorded one decides its links.
  const cliOwner = new Map<string, string>();
  for (const [id, rec] of Object.entries(state.cli ?? {})) for (const n of rec.skills) cliOwner.set(n, id);
  for (const name of Object.keys(lock)) {
    if (!valid(name, "~/.agents/.skill-lock.json")) continue;
    const setId = cliOwner.get(name);
    const set = setId ? reg.sets[setId] : undefined;
    out.push({
      name,
      dest: path.join(paths.skillsDir, name),
      links: set ? linkDirsFor(paths, set) : [],
      // No drift check: npx skills drops some files when it copies
      // (metadata.json, .git, ...) and records a sha256 for non-GitHub
      // sources, so its skillFolderHash cannot be compared with the disk.
      owner: `npx skills (${lock[name].source})`,
    });
  }
  return out;
}

export function diagnose(paths: Paths, reg: Registry, state: State, lock: Record<string, LockEntry>): Finding[] {
  const findings: Finding[] = [];
  const owned = ownedSkills(paths, reg, state, lock, findings);
  const trash = trashDir(paths.stateDir, "doctor");
  const toTrash = (from: string) => () => moveToTrash(trash, from, path.relative(paths.home, from));

  // Two owners for one name.
  const byName = new Map<string, Owned[]>();
  for (const o of owned) byName.set(o.name, [...(byName.get(o.name) ?? []), o]);
  for (const [name, os] of byName) {
    if (os.length > 1) findings.push({ kind: "collision", message: `${name} is claimed by ${os.map((o) => o.owner).join(" and ")}` });
  }

  for (const o of owned) {
    const disk = fs.existsSync(o.dest) ? treeHash(o.dest) : null;
    if (o.installed && disk && disk !== o.installed) {
      findings.push({
        kind: "edited",
        message: `${o.name} (${o.owner}) differs from what was installed; skl update keeps it until there is something new to write, then replaces it and keeps the edit in trash`,
      });
    }
    // Links skillport owns: missing ones can be recreated.
    for (const dir of o.links) {
      const at = path.join(dir, o.name);
      if (!fs.lstatSync(at, { throwIfNoEntry: false }) && disk) {
        findings.push({
          kind: "missing-link",
          message: `${at} is missing`,
          fix: () => {
            if (fs.lstatSync(at, { throwIfNoEntry: false })) return;
            fs.mkdirSync(dir, { recursive: true });
            fs.symlinkSync(o.dest, at);
          },
        });
      }
    }
    // Copies of an owned skill in agent folders, left by a vendor installer.
    for (const dir of paths.agentDirs) {
      const at = path.join(dir, o.name);
      const st = fs.lstatSync(at, { throwIfNoEntry: false });
      if (!st || isOursOrFree(at, o.dest)) continue;
      if (st.isSymbolicLink()) continue; // someone else's link; not a copy
      if (!st.isDirectory()) continue;
      // Same skill if it matches exactly, or once the per-agent files an
      // installer is known to add are left out. Anything else you added makes
      // it a different copy, which --fix never touches.
      // A copy in a link folder this skill is not linked into (a hand
      // install with --copy, say) may be the only one that agent reads:
      // report it, never move it.
      const onlyCopyThere = paths.links.includes(dir) && !o.links.includes(dir);
      const same = disk !== null && !onlyCopyThere && sameSkill(at, o.dest, [disk, ...(o.vendor ? [o.vendor] : [])]);
      // Fixes run after a confirmation prompt: each one checks again that
      // the thing it acts on is still what was reported.
      const stillSame = () =>
        fs.lstatSync(at, { throwIfNoEntry: false })?.isDirectory() === true &&
        fs.existsSync(o.dest) &&
        sameSkill(at, o.dest, [treeHash(o.dest), ...(o.vendor ? [o.vendor] : [])]);
      findings.push({
        kind: "stray-copy",
        message: `${at} is a separate copy of ${o.name} (${o.owner})${
          same ? ", identical" : onlyCopyThere ? ", and the only copy that agent reads here: keep it, or link it by hand" : ", different content: keep or delete by hand"
        }`,
        // In a folder that should hold our link (~/.claude/skills), the link
        // replaces the copy in the same step, so the agent never loses it.
        fix: same
          ? () => {
              if (!stillSame()) return;
              toTrash(at)();
              if (o.links.includes(dir)) fs.symlinkSync(o.dest, at);
            }
          : undefined,
      });
    }
  }

  // Links into skillsDir that point nowhere.
  for (const dir of new Set([...paths.links, ...paths.agentDirs])) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isSymbolicLink()) continue;
      const at = path.join(dir, e.name);
      const target = path.resolve(dir, fs.readlinkSync(at));
      if (fs.existsSync(target)) continue;
      if (target.startsWith(paths.skillsDir + path.sep)) {
        const stillBroken = () => {
          const st = fs.lstatSync(at, { throwIfNoEntry: false });
          return Boolean(st?.isSymbolicLink()) && path.resolve(dir, fs.readlinkSync(at)) === target && !fs.existsSync(target);
        };
        findings.push({
          kind: "broken-link",
          message: `${at} points to missing ${target}`,
          fix: () => (stillBroken() ? toTrash(at)() : undefined),
        });
      } else {
        // Not ours to judge: report, never touch.
        findings.push({ kind: "broken-link", message: `${at} points to missing ${target} (not a skillport link; check by hand)` });
      }
    }
  }

  // Folders in skillsDir that nobody owns.
  const names = new Set(owned.map((o) => o.name));
  if (fs.existsSync(paths.skillsDir)) {
    for (const e of fs.readdirSync(paths.skillsDir, { withFileTypes: true })) {
      // A symlink there is something you linked in on purpose (e.g. your own
      // skill from ~/dev); only real folders can be leftovers.
      if (e.name.startsWith(".") || names.has(e.name) || e.isSymbolicLink()) continue;
      findings.push({ kind: "unowned", message: `${path.join(paths.skillsDir, e.name)} has no owner; skl adopt <set> takes it over if a set ships it` });
    }
  }

  // Rename rules that no longer do anything. A rename you chose inside the
  // installer is a preference, not a fix, so it is never flagged as unneeded.
  for (const [id, set] of Object.entries(reg.sets)) {
    if (!isManaged(set)) continue;
    const synced = state.sets[id];
    for (const [original, rule] of Object.entries(set.rename ?? {})) {
      const undo = `skl resolve ${id} ${original} --undo`;
      const shipped = !synced || Object.entries(synced.skills).some(([n, s]) => (s.original ?? n) === original);
      if (!shipped && !(set.exclude ?? []).includes(original)) {
        findings.push({ kind: "stale-rule", message: `${id}: ${original} is no longer shipped, so rename ${original} → ${rule.to} does nothing; remove it with ${undo}` });
        continue;
      }
      // Still needed while anything else holds the original name: another
      // owner, an unowned folder in skillsDir, or a link skillport did not make.
      const originalDest = path.join(paths.skillsDir, original);
      const ownOwn = owned.some((o) => o.name === original && o.setId === id);
      const held =
        owned.some((o) => o.name === original && o.setId !== id) ||
        (!ownOwn && Boolean(fs.lstatSync(originalDest, { throwIfNoEntry: false }))) ||
        (!ownOwn && paths.links.some((d) => !isOursOrFree(path.join(d, original), originalDest)));
      if (!held && rule.reason !== RENAMED_IN_INSTALLER) {
        findings.push({ kind: "stale-rule", message: `${id}: rename ${original} → ${rule.to} (${rule.reason}) is no longer needed; undo with ${undo}` });
      }
    }
  }
  return findings;
}

/**
 * v2: what drifted from the manifest and lock. --fix only does what needs no
 * judgement: recreate a missing link, drop a link to a folder that is gone,
 * and move an identical stray copy to trash. Edits and unknown folders are
 * reported, never touched.
 */
export function diagnoseV2(paths: Paths, manifest: Manifest, lock: Lock): Finding[] {
  const findings: Finding[] = [];
  const trash = trashDir(paths.sklDir, "doctor");
  const toTrash = (at: string) => moveToTrash(trash, at, path.relative(paths.home, at));

  for (const [id, entry] of Object.entries(lock.skills) as [SkillId, SkillLock][]) {
    const { source: sid, original } = splitSkillId(id);
    const source = manifest.sources[sid];
    const dest = path.join(paths.skillsDir, entry.name);
    const disk = fs.lstatSync(dest, { throwIfNoEntry: false })?.isDirectory() ? treeHash(dest) : null;
    if (!disk) findings.push({ kind: "missing", message: `${dest} (${id}) is gone; skl sync installs it again` });
    else if (disk !== entry.output) {
      findings.push({ kind: "edited", message: `${entry.name} (${id}) was changed in place; skl keeps it. To replace it: skl sync --discard-edits` });
    }
    const dirs = source ? linkDirs(paths, manifest, source) : [];
    for (const dir of dirs) {
      const at = path.join(dir, entry.name);
      if (fs.lstatSync(at, { throwIfNoEntry: false }) || !disk) continue;
      findings.push({
        kind: "missing-link",
        message: `${at} is missing`,
        fix: () => {
          if (fs.lstatSync(at, { throwIfNoEntry: false })) return;
          fs.mkdirSync(dir, { recursive: true });
          fs.symlinkSync(dest, at);
        },
      });
    }
    // Copies under either name in agent folders, left by an installer or a
    // hand copy. Identical ones are safe to drop; agents read ~/.agents/skills.
    const same = new Set([entry.output, entry.base]);
    const base = storedAt(paths, sid, original, entry.base);
    for (const dir of paths.agentDirs) {
      for (const name of new Set([entry.name, original])) {
        const at = path.join(dir, name);
        const st = fs.lstatSync(at, { throwIfNoEntry: false });
        if (!st?.isDirectory() || st.isSymbolicLink()) continue;
        const identical = same.has(treeHash(at)) || (fs.existsSync(base) && sameSkill(at, base, [entry.base]));
        const linkHere = dirs.includes(dir) && name === entry.name;
        findings.push({
          kind: "stray-copy",
          message: `${at} is a separate copy of ${entry.name} (${id})${identical ? ", identical" : ", different content: keep or delete it by hand"}`,
          fix: identical
            ? () => {
                if (!fs.lstatSync(at, { throwIfNoEntry: false })?.isDirectory()) return;
                toTrash(at);
                if (linkHere && disk) fs.symlinkSync(dest, at);
              }
            : undefined,
        });
      }
    }
  }

  for (const dir of new Set([...paths.links, ...paths.agentDirs])) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isSymbolicLink()) continue;
      const at = path.join(dir, e.name);
      const target = path.resolve(dir, fs.readlinkSync(at));
      if (fs.existsSync(target) || !target.startsWith(paths.skillsDir + path.sep)) continue;
      findings.push({
        kind: "broken-link",
        message: `${at} points to missing ${target}`,
        fix: () => {
          const st = fs.lstatSync(at, { throwIfNoEntry: false });
          if (st?.isSymbolicLink() && !fs.existsSync(path.resolve(dir, fs.readlinkSync(at)))) toTrash(at);
        },
      });
    }
  }

  for (const e of externalSkills(paths, lock).values()) {
    if (e.kind === "unowned") findings.push({ kind: "unowned", message: `${path.join(paths.skillsDir, e.name)} was not installed by skl or npx skills; skl leaves it alone` });
    if (e.kind === "skillport-v1") findings.push({ kind: "unowned", message: `${e.name} is managed by skillport v1; skl migrate moves it to v2` });
  }

  if (fs.existsSync(paths.patchesDir)) {
    for (const e of fs.readdirSync(paths.patchesDir, { withFileTypes: true, recursive: true })) {
      if (!e.isFile() || !e.name.endsWith(".patch")) continue;
      const note = path.join(e.parentPath, e.name.replace(/\.patch$/, ".note.md"));
      if (!fs.existsSync(note)) findings.push({ kind: "no-note", message: `${path.join(e.parentPath, e.name)} has no note; write why in ${note}` });
    }
  }
  return findings;
}
