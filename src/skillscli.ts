import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxEnv } from "./acquire.ts";
import type { Paths, SkillsCliSet } from "./registry.ts";
import type { LockEntry, State } from "./state.ts";

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-skills-"));
  try {
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
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
    .filter(([, e]) => normalizeSource(e.source) === want)
    .map(([name]) => name)
    .sort();
}

export interface CliPlan {
  set: string;
  source: string;
  add: string[];
  update: string[];
  remove: string[];
  unselected: string[];
  collisions: { name: string; holder: string }[];
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
      collisions.push({ name, holder: `set "${managed[0]}"` });
      continue;
    }
    if (lock[name]) {
      collisions.push({ name, holder: `npx skills (${lock[name].source})` });
      continue;
    }
    const dest = path.join(paths.skillsDir, name);
    if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
      collisions.push({ name, holder: `an unmanaged folder ${dest}` });
      continue;
    }
    for (const dir of paths.links) {
      const at = path.join(dir, name);
      const st = fs.lstatSync(at, { throwIfNoEntry: false });
      if (st && !st.isSymbolicLink()) collisions.push({ name, holder: `${at}, which is not a symlink` });
    }
  }
  return {
    set: setId,
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
export function upstreamChanges(lock: Record<string, LockEntry>, names: string[]): {
  changed: string[];
  unknown: string[];
} {
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const e = lock[name];
    const repo = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(e.sourceUrl ?? "")?.[1];
    if (!repo || !e.skillPath) {
      unknown.push(name);
      continue;
    }
    const dir = path.posix.dirname(e.skillPath);
    const r = spawnSync("gh", ["api", `repos/${repo}/git/trees/HEAD:${dir}`, "--jq", ".sha"], { encoding: "utf8" });
    const sha = r.status === 0 ? r.stdout.trim() : "";
    if (!sha) unknown.push(name);
    else if (sha !== e.skillFolderHash) changed.push(name);
  }
  return { changed, unknown };
}
