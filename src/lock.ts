import fs from "node:fs";
import path from "node:path";
import type { SkillId, SourceId } from "./manifest.ts";
import { isValidSkillName } from "./transform.ts";

// What skl last installed, so it can tell upstream changes from your edits.
// See docs/SPEC-v2.md §5.2. Hashes are git tree hashes.

export interface SourceLock {
  /** GitHub: commit. installer and npm: pinned version. local: tree hash. */
  resolved: string;
  syncedAt: string;
  /** Originals upstream has offered and you have seen. */
  seen: string[];
  /** github: each skill's folder in the repo, by original name. */
  paths?: Record<string, string>;
}

export interface SkillLock {
  /** Installed name. */
  name: string;
  /** Tree hash of the vendor's content in the store. */
  base: string;
  /** Tree hash of what was written to ~/.agents/skills. */
  output: string;
  /** Hash of the patch file, when the skill is customized. */
  patch?: string;
  updatedAt: string;
}

export interface Lock {
  version: 2;
  sources: Record<SourceId, SourceLock>;
  skills: Record<SkillId, SkillLock>;
}

export function readLock(file: string): Lock {
  if (!fs.existsSync(file)) return { version: 2, sources: {}, skills: {} };
  const lock = JSON.parse(fs.readFileSync(file, "utf8")) as Lock;
  if (lock.version !== 2) throw new Error(`${file}: unsupported lock version ${lock.version}`);
  // Installed names are joined into paths that get moved to trash.
  const bad = Object.entries(lock.skills).filter(([, s]) => !isValidSkillName(s.name));
  if (bad.length) throw new Error(`${file}: invalid installed names for ${bad.map(([id]) => id).join(", ")}`);
  return lock;
}

/** Writes through a temporary file, so a crash never leaves half a lock. */
export function writeLock(file: string, lock: Lock): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
