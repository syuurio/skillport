import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sandboxEnv } from "./acquire.ts";
import { withTempDir } from "./fsutil.ts";
import { isOursOrFree } from "./apply.ts";
import type { Paths, SkillsCliSet } from "./registry.ts";
import type { Collision } from "./plan.ts";
import type { LockEntry, State } from "./state.ts";
import { isValidSkillName } from "./transform.ts";

// skills-cli sets are delegated to `npx skills`, which owns their folders,
// links and lock entries. skillport decides what to ask it for, checks
// collisions first (npx skills overwrites an existing folder silently,
// verified), and reads its lock to report.

export const SKILLS_CLI = "skills@1.7.0";

/** `owner/repo` for GitHub sources in any spelling; other sources as given. */
export function normalizeSource(source: string): string {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(source.trim());
  return m ? m[1] : source.trim();
}

function run(paths: Paths, args: string[]): { status: number | null; out: string } {
  return withTempDir("skills", (tmp) => {
    // Real HOME: npx skills installs into ~/.agents. The environment is still
    // the minimal one, so it sees no shell secrets.
    const r = spawnSync("npx", ["-y", SKILLS_CLI, ...args], {
      cwd: paths.home,
      encoding: "utf8",
      env: sandboxEnv(paths.home, tmp),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000,
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  });
}

/**
 * Skill names in `skills add <source> --list` output. The CLI has no JSON
 * form for --list (it refuses `--json` with `--list`), so this reads the
 * listing: each skill name sits alone on a `│    name` line, its
 * description on deeper-indented lines.
 */
export function parseList(output: string): string[] {
  const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const names = [...plain.matchAll(/^│ {4}([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/gm)].map((m) => m[1]);
  return [...new Set(names)];
}

export function listSource(paths: Paths, source: string): string[] {
  const r = run(paths, ["add", source, "--list"]);
  const names = parseList(r.out);
  if (r.status !== 0 || names.length === 0) {
    throw new Error(`npx skills could not list "${source}".\n${r.out.slice(-2000)}`);
  }
  return names;
}

/** `-a` flags: Codex always (puts the real folder in ~/.agents/skills), Claude Code when linked. */
export function agentArgs(links: string[], claudeDir: string): string[] {
  return ["-a", "codex", ...(links.includes(claudeDir) ? ["-a", "claude-code"] : [])];
}

export function lockedFor(lock: Record<string, LockEntry>, source: string): string[] {
  const want = normalizeSource(source);
  return Object.entries(lock)
    .filter(([name, e]) => isValidSkillName(name) && normalizeSource(e.source) === want)
    .map(([name]) => name)
    .sort();
}

export interface CliPlan {
  setId: string;
  source: string;
  add: string[];
  update: string[];
  remove: string[];
  unselected: string[];
  collisions: Omit<Collision, "original">[];
}

/** What to ask npx skills for, and which names it must not touch. */
export function planCli(input: {
  paths: Paths;
  setId: string;
  set: SkillsCliSet;
  available: string[];
  lock: Record<string, LockEntry>;
  state: State;
}): CliPlan {
  const { paths, setId, set, available, lock, state } = input;
  const excluded = new Set(set.exclude ?? []);
  const allow = set.skills ? new Set(set.skills) : null;
  const wanted = available.filter((n) => !excluded.has(n) && (!allow || allow.has(n)));
  const unselected = available.filter((n) => !excluded.has(n) && allow && !allow.has(n));
  const installed = new Set(lockedFor(lock, set.source));
  const add = wanted.filter((n) => !installed.has(n));
  const collisions: CliPlan["collisions"] = [];
  for (const name of add) {
    const managed = Object.entries(state.sets).find(([, st]) => name in st.skills);
    if (managed) {
      collisions.push({ name, kind: "set", holderId: managed[0], holder: `set "${managed[0]}"` });
      continue;
    }
    if (lock[name]) {
      collisions.push({ name, kind: "lock", holderId: lock[name].source, holder: `npx skills (${lock[name].source})` });
      continue;
    }
    const dest = path.join(paths.skillsDir, name);
    if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
      collisions.push({ name, kind: "unowned", holder: `an unmanaged folder ${dest}` });
      continue;
    }
    // Anything already at the link path that is not a link to our folder
    // (a real folder, or your own symlink elsewhere) would be replaced.
    for (const dir of paths.links) {
      const at = path.join(dir, name);
      if (!isOursOrFree(at, dest)) collisions.push({ name, kind: "link", holder: `${at}, which skillport did not create` });
    }
  }
  return {
    setId,
    source: set.source,
    add,
    update: [...installed].filter((n) => wanted.includes(n)),
    remove: [...installed].filter((n) => !wanted.includes(n)),
    unselected,
    collisions,
  };
}

export function applyCli(paths: Paths, p: CliPlan, links: string[]): void {
  const agents = agentArgs(links, paths.linkTargets["claude-code"]);
  const step = (args: string[]) => {
    const r = run(paths, args);
    if (r.status !== 0) throw new Error(`npx skills ${args[0]} failed.\n${r.out.slice(-2000)}`);
  };
  if (p.remove.length) step(["remove", ...p.remove, "-g", "-y"]);
  if (p.add.length) step(["add", p.source, "-g", ...agents, ...p.add.flatMap((n) => ["-s", n]), "-y"]);
  if (p.update.length) step(["update", ...p.update, "-g", "-y"]);
}

/**
 * Compare each installed skill's `skillFolderHash` (a git tree hash, verified)
 * with the tree hash of its folder on GitHub's default branch. Non-GitHub
 * sources cannot be checked this way and are reported as such.
 */
/**
 * Tree hash of a folder on a GitHub repo's default branch. Uses `gh` (5000
 * requests an hour when logged in) and falls back to GitHub's public API
 * through curl (60 an hour, no login). Empty when neither answers.
 */
export function treeShaOnGitHub(repo: string, dir: string): string {
  const route = `repos/${repo}/git/trees/HEAD:${dir}`;
  const gh = spawnSync("gh", ["api", route, "--jq", ".sha"], { encoding: "utf8" });
  if (gh.status === 0 && gh.stdout.trim()) return gh.stdout.trim();
  const curl = spawnSync("curl", ["-fsSL", "-H", "Accept: application/vnd.github+json", `https://api.github.com/${route}`], {
    encoding: "utf8",
  });
  if (curl.status !== 0) return "";
  try {
    return (JSON.parse(curl.stdout) as { sha?: string }).sha ?? "";
  } catch {
    return "";
  }
}

/**
 * Compare each installed skill's `skillFolderHash` (a git tree hash, verified)
 * with its folder on GitHub's default branch. Changed skills come with a link
 * to that folder's commit history. Non-GitHub sources, or no answer from
 * GitHub, end up in `unknown`.
 */
export function upstreamChanges(
  lock: Record<string, LockEntry>,
  names: string[],
): { changed: string[]; unknown: string[]; links: Record<string, string> } {
  const changed: string[] = [];
  const unknown: string[] = [];
  const links: Record<string, string> = {};
  for (const name of names) {
    const e = lock[name];
    const repo = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(e.sourceUrl ?? "")?.[1];
    if (!repo || !e.skillPath) {
      unknown.push(name);
      continue;
    }
    const dir = path.posix.dirname(e.skillPath);
    const sha = treeShaOnGitHub(repo, dir);
    if (!sha) unknown.push(name);
    else if (sha !== e.skillFolderHash) {
      changed.push(name);
      links[name] = `https://github.com/${repo}/commits/HEAD/${dir}`;
    }
  }
  return { changed, unknown, links };
}
