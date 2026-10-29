import fs from "node:fs";
import path from "node:path";
import type { Lock } from "./lock.ts";
import type { Paths } from "./paths.ts";
import { readSkillLock } from "./npxskills.ts";
import { isValidSkillName } from "./transform.ts";

// Skills in ~/.agents/skills that skl v2 did not install. They are only read:
// for the collision check before every write, and for doctor. See SPEC §9.

export type ExternalKind = "npx-skills" | "unowned";

export interface External {
  name: string;
  kind: ExternalKind;
  /** npx skills: the source it was installed from. */
  source?: string;
}

const WHAT: Record<ExternalKind, string> = {
  "npx-skills": "an external npx skills install",
  unowned: "a folder in ~/.agents/skills that skl did not install",
};

export const describeExternal = (e: External) => (e.source ? `${WHAT[e.kind]} (${e.source})` : WHAT[e.kind]);

/** Every installed skill skl v2 does not own, by name. */
export function externalSkills(paths: Paths, lock: Lock): Map<string, External> {
  const ours = new Set(Object.values(lock.skills).map((s) => s.name));
  const out = new Map<string, External>();
  // npx skills first: it may list a skill whose folder is gone, and its
  // next `npx skills update` would bring the folder back.
  for (const [name, e] of Object.entries(readSkillLock(paths.skillLock))) {
    if (!ours.has(name)) out.set(name, { name, kind: "npx-skills", source: e.source });
  }
  const entries = fs.existsSync(paths.skillsDir) ? fs.readdirSync(paths.skillsDir) : [];
  for (const name of entries) {
    if (name.startsWith(".") || ours.has(name) || out.has(name) || !isValidSkillName(name)) continue;
    out.set(name, { name, kind: "unowned" });
  }
  return out;
}

/** Whether `at`, in a link target, is anything other than nothing or our link to `name`. */
export function foreignInTarget(paths: Paths, dir: string, name: string): boolean {
  const at = path.join(dir, name);
  const st = fs.lstatSync(at, { throwIfNoEntry: false });
  if (!st) return false;
  return !st.isSymbolicLink() || path.resolve(dir, fs.readlinkSync(at)) !== path.join(paths.skillsDir, name);
}
