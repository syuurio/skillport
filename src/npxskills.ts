import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { sandboxEnv } from "./acquire.ts";
import { withTempDir } from "./fsutil.ts";
import type { Paths } from "./paths.ts";

// Your own `npx skills` setup: skl reads its lock, and removes skills through
// it only when you adopt them (SPEC §9).

export const SKILLS_CLI = "skills@1.7.4";

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
  const lock = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; skills: Record<string, LockEntry> };
  if (lock.version !== 3) {
    throw new Error(`${file} is version ${lock.version}; skillport understands version 3. Pin npx skills or update skillport.`);
  }
  return lock.skills;
}

/** Remove skills through npx skills, on your real HOME. A real delete: callers pass only names they took over. */
export function removeCliSkills(paths: Paths, names: string[]): void {
  const r = withTempDir("skills", (tmp) =>
    // The environment is the minimal one, so npx skills sees no shell secrets.
    spawnSync("npx", ["-y", SKILLS_CLI, "remove", ...names, "-g", "-y"], {
      cwd: paths.home,
      encoding: "utf8",
      env: sandboxEnv(paths.home, tmp),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000,
    }),
  );
  if (r.status !== 0) throw new Error(`npx skills remove failed.\n${`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-2000)}`);
}
