import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sandboxEnv } from "../acquire.ts";
import type { GithubSource, SourceId } from "../manifest.ts";
import { SKILLS_CLI } from "../npxskills.ts";
import { githubRepo } from "../validate.ts";
import { type FetchOptions, type Fetched, skillsIn } from "./index.ts";

// GitHub sources go through `npx skills`, so its discovery rules apply, but
// on a shadow HOME of their own: your ~/.agents/.skill-lock.json is never
// read or written. The shadow is kept between runs (SPEC §7.1).

const TIMEOUT_MS = 5 * 60 * 1000;

/** What npx skills@1.7.0 leaves out when it copies a skill (its copyDirectory). */
export const copySkips = (name: string, isDir: boolean) =>
  name === "metadata.json" || (isDir && (name === ".git" || name === "__pycache__" || name === "__pypackages__"));

export function shadowHome(sklDir: string, id: SourceId): string {
  return path.join(sklDir, "cli", id);
}

/** The commit HEAD points at, from `git ls-remote`. */
export function headCommit(url: string, env: Record<string, string>): string {
  const r = spawnSync("git", ["ls-remote", url, "HEAD"], { encoding: "utf8", env, timeout: 60_000 });
  const sha = /^([0-9a-f]{40})\tHEAD$/m.exec(r.stdout ?? "")?.[1];
  if (r.status !== 0 || !sha) throw new Error(`git ls-remote ${url} failed.\n${(r.stderr ?? "").trim()}`);
  return sha;
}

/** Install every skill of the repo into the shadow HOME and take its folders. */
export function fetchGithub(id: SourceId, source: GithubSource, opts: FetchOptions): Fetched {
  const repo = githubRepo(source.repo);
  if (!repo) throw new Error(`sources.${id}: repo must be owner/repo or a GitHub URL`);
  const url = `https://github.com/${repo}`;
  const shadow = shadowHome(opts.sklDir, id);
  const skills = path.join(shadow, ".agents", "skills");
  // npx skills overwrites folders but never removes ones upstream dropped;
  // start empty so what is left is exactly this run's.
  fs.rmSync(skills, { recursive: true, force: true });
  fs.mkdirSync(shadow, { recursive: true, mode: 0o700 });
  fs.rmSync(opts.staging, { recursive: true, force: true });
  fs.mkdirSync(opts.staging, { recursive: true, mode: 0o700 });

  // HOME is the shadow, and the minimal environment leaves out
  // XDG_STATE_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME, any of which would
  // send npx skills to your real folders.
  const env = sandboxEnv(shadow, opts.staging);
  const commit = headCommit(url, env);
  // Naming the commit installs exactly what is recorded, and keeps npx skills
  // on its git clone: without a ref it fetches a few owners' repos (vercel,
  // vercel-labs, ...) as skills.sh snapshots instead, which keep metadata.json,
  // drop exec bits and may lag HEAD, so check could never match them.
  const r = spawnSync("npx", ["-y", SKILLS_CLI, "add", `${url}#${commit}`, "-g", "-a", "codex", "-s", "*", "-y"], {
    cwd: shadow,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`npx skills could not install ${url}.\n${`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-2000)}`);
  if (!fs.existsSync(skills)) throw new Error(`npx skills installed nothing from ${url}.`);
  return { resolved: commit, skills: skillsIn(skills), paths: repoPaths(shadow) };
}

/**
 * Where each skill sits in the repo, from the shadow's npx skills lock. A
 * folder is often named differently from its skill (composition-patterns
 * holds vercel-composition-patterns), so check cannot go by folder names.
 */
function repoPaths(shadow: string): Record<string, string> {
  const file = path.join(shadow, ".agents", ".skill-lock.json");
  if (!fs.existsSync(file)) return {};
  const { skills } = JSON.parse(fs.readFileSync(file, "utf8")) as { skills: Record<string, { skillPath?: string }> };
  return Object.fromEntries(
    Object.entries(skills)
      .filter(([, e]) => typeof e.skillPath === "string")
      .map(([name, e]) => [name, path.posix.dirname(e.skillPath as string)]),
  );
}
