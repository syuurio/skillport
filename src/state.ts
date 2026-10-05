import fs from "node:fs";
import path from "node:path";

// What skillport actually installed. Hashes are of the vendor's original
// content (before any rename), so a rename never reads as an upstream change.

export interface InstalledSkill {
  /** Vendor name, when it differs from the installed name. */
  original?: string;
  /** Tree hash of the vendor's content: compared against upstream. */
  hash: string;
  /** Tree hash of what skillport wrote: compared against disk for drift. */
  installed: string;
  updatedAt: string;
}

export interface SetState {
  syncedAt: string;
  skills: Record<string, InstalledSkill>;
}

export interface State {
  version: 1;
  sets: Record<string, SetState>;
}

export function readState(stateDir: string): State {
  const file = path.join(stateDir, "state.json");
  if (!fs.existsSync(file)) return { version: 1, sets: {} };
  return JSON.parse(fs.readFileSync(file, "utf8")) as State;
}

export function writeState(stateDir: string, state: State): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "state.json");
  // Write-then-rename so a crash never leaves a truncated state file.
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

/** `npx skills` lock entries, read-only. Refuses formats it does not know. */
export interface LockEntry {
  source: string;
  sourceUrl?: string;
  skillPath: string;
  skillFolderHash: string;
  updatedAt: string;
}

export function readSkillLock(file: string): Record<string, LockEntry> {
  if (!fs.existsSync(file)) return {};
  const lock = JSON.parse(fs.readFileSync(file, "utf8")) as {
    version: number;
    skills: Record<string, LockEntry>;
  };
  if (lock.version !== 3) {
    throw new Error(
      `${file} is version ${lock.version}; skillport understands version 3. Pin npx skills or update skillport.`,
    );
  }
  return lock.skills;
}
