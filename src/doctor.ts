import fs from "node:fs";
import path from "node:path";
import { isOursOrFree, trashDir } from "./apply.ts";
import { type Paths, type Registry, isManaged, linkDirsFor } from "./registry.ts";
import type { LockEntry, State } from "./state.ts";
import { isValidSkillName } from "./transform.ts";
import { treeHash, treeHashWithout } from "./treehash.ts";

// `skl doctor`: find what drifted from the registry, state and lock, and fix
// what can be fixed without a judgement call. Everything removed goes to the
// trash; anything that needs a decision is only reported.

export type Kind = "stray-copy" | "broken-link" | "missing-link" | "collision" | "edited" | "unowned" | "stale-rule";

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
  /** Folders that should hold our link to it. */
  links: string[];
  owner: string;
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
    bad.push({ kind: "collision", message: `${where} lists an invalid skill name ${JSON.stringify(name)}; it is ignored. Fix that file by hand.` });
    return false;
  };
  for (const [id, st] of Object.entries(state.sets)) {
    const set = reg.sets[id];
    const links = set ? linkDirsFor(paths, set) : [];
    for (const [name, s] of Object.entries(st.skills)) {
      if (!valid(name, `state.json (set "${id}")`)) continue;
      out.push({ name, dest: path.join(paths.skillsDir, name), installed: s.installed, links, owner: `set "${id}"` });
    }
  }
  for (const name of Object.keys(lock)) {
    if (!valid(name, "~/.agents/.skill-lock.json")) continue;
    out.push({ name, dest: path.join(paths.skillsDir, name), links: [], owner: `npx skills (${lock[name].source})` });
  }
  return out;
}

export function diagnose(paths: Paths, reg: Registry, state: State, lock: Record<string, LockEntry>): Finding[] {
  const findings: Finding[] = [];
  const owned = ownedSkills(paths, reg, state, lock, findings);
  const trash = trashDir(paths, "doctor");
  const toTrash = (from: string) => () => {
    const rel = path.relative(paths.home, from);
    const to = path.join(trash, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  };

  // Two owners for one name.
  const byName = new Map<string, Owned[]>();
  for (const o of owned) byName.set(o.name, [...(byName.get(o.name) ?? []), o]);
  for (const [name, os] of byName) {
    if (os.length > 1) findings.push({ kind: "collision", message: `${name} is claimed by ${os.map((o) => o.owner).join(" and ")}` });
  }

  for (const o of owned) {
    const disk = fs.existsSync(o.dest) ? treeHash(o.dest) : null;
    if (o.installed && disk && disk !== o.installed) {
      findings.push({ kind: "edited", message: `${o.name} (${o.owner}) was edited on disk since install; skl update replaces it, keeping the edit in trash` });
    }
    // Links skillport owns: missing ones can be recreated.
    for (const dir of o.links) {
      const at = path.join(dir, o.name);
      if (!fs.lstatSync(at, { throwIfNoEntry: false }) && disk) {
        findings.push({
          kind: "missing-link",
          message: `${at} is missing`,
          fix: () => {
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
      // Same skill if it matches exactly, or once per-agent extras the
      // installer added (and our copy lacks) are left out.
      const extras = fs.readdirSync(at).filter((e) => !fs.existsSync(path.join(o.dest, e)));
      const same = disk !== null && (treeHash(at) === disk || (extras.length > 0 && treeHashWithout(at, extras) === disk));
      findings.push({
        kind: "stray-copy",
        message: `${at} is a separate copy of ${o.name} (${o.owner})${same ? ", identical" : ", different content: keep or delete by hand"}`,
        fix: same ? toTrash(at) : undefined,
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
      if (target.startsWith(paths.skillsDir + path.sep) && !fs.existsSync(target)) {
        findings.push({ kind: "broken-link", message: `${at} points to missing ${target}`, fix: () => fs.unlinkSync(at) });
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

  // Rename and exclude rules whose reason no longer holds.
  for (const [id, set] of Object.entries(reg.sets)) {
    if (!isManaged(set)) continue;
    for (const [original, rule] of Object.entries(set.rename ?? {})) {
      const held = owned.some((o) => o.name === original && o.owner !== `set "${id}"`);
      if (!held && rule.reason.startsWith("collides")) {
        findings.push({ kind: "stale-rule", message: `${id}: rename ${original} → ${rule.to} (${rule.reason}) is no longer needed; undo with skl resolve ${id} ${original} --undo` });
      }
    }
  }
  return findings;
}
