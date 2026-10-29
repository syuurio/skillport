import fs from "node:fs";
import path from "node:path";
import { isOursOrFree, moveToTrash, trashDir } from "./apply.ts";
import { externalSkills } from "./external.ts";
import type { Lock, SkillLock } from "./lock.ts";
import { type Manifest, type SkillId, splitSkillId } from "./manifest.ts";
import { storedAt } from "./store.ts";
import { linkDirs } from "./sync.ts";
import type { Paths } from "./paths.ts";
import { isValidSkillName } from "./transform.ts";
import { sameSkill, treeHash } from "./treehash.ts";

// `skl doctor`: find what drifted from the manifest and lock, and fix
// what can be fixed without a judgement call. Everything removed goes to the
// trash; anything that needs a decision is only reported.

export type Kind =
  | "stray-copy"
  | "broken-link"
  | "missing-link"
  | "missing"
  | "edited"
  | "unowned"
  | "no-note";

export interface Finding {
  kind: Kind;
  message: string;
  /** Present when --fix can resolve it without asking. */
  fix?: () => void;
}

/**
 * What drifted from the manifest and lock. --fix only does what needs no
 * judgement: recreate a missing link, drop a link to a folder that is gone,
 * and move an identical stray copy to trash. Edits and unknown folders are
 * reported, never touched.
 */
export function diagnose(paths: Paths, manifest: Manifest, lock: Lock): Finding[] {
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
