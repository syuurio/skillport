import fs from "node:fs";
import path from "node:path";
import { isOursOrFree, moveToTrash, trashDir } from "./apply.ts";
import { type Paths, type Registry, isManaged, linkDirsFor } from "./registry.ts";
import type { LockEntry, State } from "./state.ts";
import { RENAMED_IN_INSTALLER } from "./plan.ts";
import { isValidSkillName } from "./transform.ts";
import { treeHash, treeHashWithout } from "./treehash.ts";

// `skl doctor`: find what drifted from the registry, state and lock, and fix
// what can be fixed without a judgement call. Everything removed goes to the
// trash; anything that needs a decision is only reported.

export type Kind = "stray-copy" | "broken-link" | "missing-link" | "collision" | "invalid" | "edited" | "unowned" | "stale-rule";

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
      out.push({ name, dest: path.join(paths.skillsDir, name), installed: s.installed, links, owner: `set "${id}"`, setId: id });
    }
  }
  for (const name of Object.keys(lock)) {
    if (!valid(name, "~/.agents/.skill-lock.json")) continue;
    out.push({ name, dest: path.join(paths.skillsDir, name), links: [], owner: `npx skills (${lock[name].source})` });
  }
  return out;
}

/**
 * Top-level entries installers add for one agent: Emil's installers write
 * `agents/openai.yaml` for Codex (verified). Only an `agents` folder holding
 * nothing but that file qualifies, and only when our copy has no `agents`.
 */
function knownAgentExtras(copy: string, ours: string): string[] {
  const agents = path.join(copy, "agents");
  if (fs.existsSync(path.join(ours, "agents"))) return [];
  const st = fs.lstatSync(agents, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return [];
  const inside = fs.readdirSync(agents);
  return inside.length === 1 && inside[0] === "openai.yaml" ? ["agents"] : [];
}

/** A copy matches ours exactly, or once known per-agent extras are left out. */
function sameAsOurs(copy: string, ours: string): boolean {
  if (!fs.existsSync(ours)) return false;
  const disk = treeHash(ours);
  const extras = knownAgentExtras(copy, ours);
  return treeHash(copy) === disk || (extras.length > 0 && treeHashWithout(copy, extras) === disk);
}

export function diagnose(paths: Paths, reg: Registry, state: State, lock: Record<string, LockEntry>): Finding[] {
  const findings: Finding[] = [];
  const owned = ownedSkills(paths, reg, state, lock, findings);
  const trash = trashDir(paths, "doctor");
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
      const same = disk !== null && sameAsOurs(at, o.dest);
      // Fixes run after a confirmation prompt: each one checks again that
      // the thing it acts on is still what was reported.
      const stillSame = () => fs.lstatSync(at, { throwIfNoEntry: false })?.isDirectory() === true && sameAsOurs(at, o.dest);
      findings.push({
        kind: "stray-copy",
        message: `${at} is a separate copy of ${o.name} (${o.owner})${same ? ", identical" : ", different content: keep or delete by hand"}`,
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
