import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestVersion, sandboxEnv } from "./acquire.ts";
import { hasSecret } from "./keychain.ts";
import { fetchLocal } from "./adapters/local.ts";
import { copySkips, headCommit, npxSkillDirs } from "./adapters/github.ts";
import { describeExternal, externalSkills } from "./external.ts";
import type { Lock, SkillLock } from "./lock.ts";
import { type Manifest, type SkillId, type SkillName, type Source, type SourceId, installedName, splitSkillId } from "./manifest.ts";
import type { Paths } from "./paths.ts";
import type { SkillFlags, SourceStatus, Status } from "./status.ts";
import { type GitEntry, treeHash, treeHashOfListing } from "./treehash.ts";
import { githubRepo, isPinnedSpec } from "./validate.ts";

// `skl check`: is anything new upstream? Writes status.json, never a skill.
// GitHub costs nothing while HEAD has not moved and one tree call when it
// has (SPEC §7.1).

export type TreeEntry = GitEntry;

/** Everything check asks the network; replaced in tests. */
export interface Net {
  /** HEAD's commit, or null when the remote cannot be reached. */
  headCommit(url: string): string | null;
  /** The repo's full tree at `commit`, or null without an answer. */
  tree(repo: string, commit: string): TreeEntry[] | null;
  /** The latest published version, or null without an answer. */
  latestVersion(name: string): string | null;
  /** Whether Keychain holds the source's token. Not the network, but outside skl all the same. */
  hasToken(source: string): boolean;
}

export function realNet(staging: string): Net {
  return {
    headCommit: (url) => {
      try {
        return headCommit(url, sandboxEnv(os.homedir(), staging));
      } catch {
        return null;
      }
    },
    tree: (repo, commit) => {
      // gh first (5000 requests an hour when logged in), then the public API.
      const route = `repos/${repo}/git/trees/${commit}?recursive=1`;
      const gh = spawnSync("gh", ["api", route], { encoding: "utf8" });
      const body =
        gh.status === 0
          ? gh.stdout
          : spawnSync("curl", ["-fsSL", "-H", "Accept: application/vnd.github+json", `https://api.github.com/${route}`], { encoding: "utf8" }).stdout;
      try {
        const t = JSON.parse(body) as { tree?: TreeEntry[]; truncated?: boolean };
        return t.tree && !t.truncated ? t.tree : null;
      } catch {
        return null;
      }
    },
    latestVersion: (name) => latestVersion(name, staging),
    hasToken: (source) => hasSecret(source),
  };
}

const short = (sha: string) => sha.slice(0, 7);

function installedOf(lock: Lock, sid: SourceId): [SkillName, SkillLock][] {
  return (Object.entries(lock.skills) as [SkillId, SkillLock][])
    .filter(([id]) => splitSkillId(id).source === sid)
    .map(([id, s]) => [splitSkillId(id).original, s]);
}

function checkGithub(sid: SourceId, source: Extract<Source, { type: "github" }>, lock: Lock, net: Net, now: string): SourceStatus {
  const repo = githubRepo(source.repo) as string;
  const from = lock.sources[sid]?.resolved;
  if (!from) return { checkedAt: now, state: "unknown", reason: `not installed yet: skl sync` };
  const to = net.headCommit(`https://github.com/${repo}`);
  if (!to) return { checkedAt: now, state: "unknown", reason: "GitHub unreachable" };
  if (to === from) return { checkedAt: now, state: "up-to-date" };
  const tree = net.tree(repo, to);
  if (!tree) return { checkedAt: now, state: "unknown", reason: "GitHub did not return the tree" };
  // Skills by their folder in the repo, as the lock recorded at install;
  // older locks without paths fall back to the folder's own name.
  const known = lock.sources[sid]?.paths;
  const dirs = npxSkillDirs(tree.filter((e) => e.type === "blob" && path.posix.basename(e.path) === "SKILL.md").map((e) => path.posix.dirname(e.path)));
  const dirOf = (o: string) => known?.[o] ?? dirs.find((d) => path.posix.basename(d) === o);
  // Hash each folder the way npx skills copies it, so files it leaves out
  // do not read as a change.
  const hashOf = (dir: string) => treeHashOfListing(tree, dir, copySkips);
  const installed = installedOf(lock, sid);
  const seen = new Set(lock.sources[sid]?.seen ?? []);
  const there = (o: string) => {
    const d = dirOf(o);
    return d !== undefined && dirs.includes(d);
  };
  const changed = installed.filter(([o, s]) => there(o) && hashOf(dirOf(o) as string) !== s.base).map(([o]) => o);
  const removed = installed.filter(([o]) => !there(o)).map(([o]) => o);
  const knownDirs = new Set([...seen].map(dirOf).filter((d): d is string => d !== undefined));
  const added = dirs
    .filter((d) => !knownDirs.has(d))
    .map((d) => (d === "." ? repo.split("/")[1] : path.posix.basename(d)))
    .sort();
  if (!changed.length && !removed.length && !added.length) return { checkedAt: now, state: "up-to-date" };
  return {
    checkedAt: now,
    state: "updates",
    from: short(from),
    to: short(to),
    changed,
    added,
    removed,
    link: `https://github.com/${repo}/compare/${short(from)}...${short(to)}`,
  };
}

function checkVersion(spec: string | undefined, net: Net, now: string): SourceStatus {
  const m = spec && isPinnedSpec(spec) ? /^(@?[^@]+)@(.+)$/.exec(spec) : null;
  if (!m) return { checkedAt: now, state: "unpinned" };
  const latest = net.latestVersion(m[1]);
  if (!latest) return { checkedAt: now, state: "unknown", reason: "npm unreachable" };
  return latest === m[2] ? { checkedAt: now, state: "up-to-date", pinned: m[2] } : { checkedAt: now, state: "pinned-behind", current: m[2], latest };
}

function checkLocal(paths: Paths, sid: SourceId, source: Extract<Source, { type: "local" }>, lock: Lock, now: string): SourceStatus {
  // No shortcut on an unchanged folder: a new skill held back for its name
  // leaves the folder recorded but the skill missing.
  const fetched = fetchLocal(source, paths.home);
  const here = new Map(fetched.skills.map((s) => [s.original as string, s.dir]));
  const installed = installedOf(lock, sid);
  const seen = new Set(lock.sources[sid]?.seen ?? []);
  const added = [...here.keys()].filter((n) => !seen.has(n)).sort();
  // A local folder's new skills are installed by the next sync, so they can collide now.
  const external = externalSkills(paths, lock);
  const collisions = added
    .map((o) => ({ o, name: installedName(sid, o as SkillName, source) }))
    .filter(({ name }) => external.has(name))
    .map(({ name }) => ({ name, with: describeExternal(external.get(name)!) }));
  if (collisions.length) return { checkedAt: now, state: "blocked", collisions };
  const changed = installed.filter(([o, s]) => here.has(o) && treeHash(here.get(o)!) !== s.base).map(([o]) => o);
  const removed = installed.filter(([o]) => !here.has(o)).map(([o]) => o);
  if (!changed.length && !removed.length && !added.length) return { checkedAt: now, state: "up-to-date" };
  const from = lock.sources[sid]?.resolved ?? "";
  return { checkedAt: now, state: "updates", from: short(from), to: short(fetched.resolved), changed, added, removed };
}

export function checkSource(paths: Paths, sid: SourceId, source: Source, lock: Lock, net: Net, now: string): SourceStatus {
  try {
    switch (source.type) {
      case "github":
        return checkGithub(sid, source, lock, net, now);
      case "npm":
        return checkVersion(source.package, net, now);
      case "installer":
        // Without its token the installer cannot run, so that comes first.
        if (source.secret === "keychain" && !net.hasToken(sid)) return { checkedAt: now, state: "needs-token" };
        return checkVersion(source.command.find(isPinnedSpec), net, now);
      case "local":
        return checkLocal(paths, sid, source, lock, now);
    }
  } catch (e) {
    return { checkedAt: now, state: "error", reason: (e as Error).message.split("\n")[0] };
  }
}

/** Flags for every installed skill: patched, changed in place, or mid-merge. */
export function skillFlags(paths: Paths, lock: Lock): Record<SkillId, SkillFlags> {
  const out: Record<SkillId, SkillFlags> = {};
  for (const [id, s] of Object.entries(lock.skills) as [SkillId, SkillLock][]) {
    const { source, original } = splitSkillId(id);
    const dest = path.join(paths.skillsDir, s.name);
    const merge = path.join(paths.sklDir, "merge", source, original);
    const flags: SkillFlags = {
      ...(s.patch ? { customized: true as const } : {}),
      ...(fs.existsSync(dest) && treeHash(dest) !== s.output ? { edited: true as const } : {}),
      ...(fs.existsSync(merge) ? { conflict: merge } : {}),
    };
    if (Object.keys(flags).length) out[id] = flags;
  }
  return out;
}

/** Check `ids` (all sources when empty), keeping earlier results for the rest. */
export function check(paths: Paths, manifest: Manifest, lock: Lock, previous: Status | null, ids: string[], net: Net, now = new Date().toISOString()): Status {
  const unknown = ids.filter((id) => !manifest.sources[id as SourceId]);
  if (unknown.length) throw new Error(`Unknown source ${unknown.join(", ")}. Known: ${Object.keys(manifest.sources).join(", ")}`);
  const which = (ids.length ? ids : Object.keys(manifest.sources)) as SourceId[];
  const sources = Object.fromEntries(
    Object.entries(previous?.sources ?? {}).filter(([id]) => manifest.sources[id as SourceId]),
  ) as Status["sources"];
  for (const sid of which) sources[sid] = checkSource(paths, sid, manifest.sources[sid], lock, net, now);
  return { checkedAt: now, sources, skills: skillFlags(paths, lock) };
}
