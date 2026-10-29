import fs from "node:fs";
import path from "node:path";
import type { Fetched } from "./adapters/index.ts";
import { moveToTrash, trashDir } from "./apply.ts";
import { foreignInTarget } from "./external.ts";
import { type Lock, readLock } from "./lock.ts";
import { type Manifest, type Source, type SourceId, installedName, parseManifest, writeManifest } from "./manifest.ts";
import { type Paths, withLinkTargets } from "./registry.ts";
import { count, home } from "./report.ts";
import { readSkillLock, removeCliSkills } from "./npxskills.ts";
import { describeSync, sync } from "./sync.ts";
import { treeHash } from "./treehash.ts";
import { githubRepo } from "./validate.ts";

// `skl migrate`: skillport v1's registry and state become a v2 manifest and
// lock (SPEC §14). v1's formats are read here and nowhere else.

interface V1Common {
  exclude?: string[];
  links?: string[];
  namespace?: string;
  rename?: Record<string, { to: string }>;
}

type V1Set =
  | (V1Common & { type: "installer"; command: string[]; unattended?: string[]; secret?: "keychain"; stage?: string[]; harvest?: string })
  | (V1Common & { type: "npm"; package: string; path: string })
  | (V1Common & { type: "skills-cli"; source: string });

export interface V1Registry {
  version: 1;
  linkTargets?: Record<string, { label?: string; dir: string }>;
  sets: Record<string, V1Set>;
}

export interface V1State {
  version: 1;
  sets: Record<string, { skills: Record<string, { original?: string; installed: string }> }>;
  cli?: Record<string, { skills: string[] }>;
}

export const v1Files = (paths: Paths) => ({
  registry: path.join(paths.home, ".config", "skillport", "registry.json"),
  state: path.join(paths.home, ".agents", ".skillport", "state.json"),
});

function readV1<T extends { version: number }>(file: string, empty: T): T {
  if (!fs.existsSync(file)) return empty;
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as T;
  if (data.version !== 1) throw new Error(`${file}: expected a skillport v1 file, found version ${data.version}`);
  return data;
}

/** One v1 skill and the name v2 gives it. */
export interface Move {
  source: SourceId;
  original: string;
  from: string;
  to: string;
}

export interface MigrationPlan {
  manifest: Manifest;
  /** installer and npm skills: same names, v2 installs them again. */
  replaced: Move[];
  /** npx skills installs: v2 installs a prefixed copy, then npx skills removes the original. */
  adopted: Move[];
  skipped: { id: string; reason: string }[];
}

/** The manifest and moves for a v1 setup; reads files only. */
export function planMigration(paths: Paths): MigrationPlan {
  const files = v1Files(paths);
  const reg = readV1<V1Registry>(files.registry, { version: 1, sets: {} });
  const state = readV1<V1State>(files.state, { version: 1, sets: {} });
  const npx = readSkillLock(paths.skillLock);
  const sources: Record<string, Source> = {};
  const skipped: MigrationPlan["skipped"] = [];
  const replacedOriginals: [string, string, string][] = [];
  const adoptedOriginals: [string, string][] = [];

  for (const [id, set] of Object.entries(reg.sets)) {
    const common = {
      ...(set.exclude?.length ? { exclude: set.exclude } : {}),
      ...(set.links ? { links: set.links } : {}),
    };
    if (set.type === "skills-cli") {
      const repo = githubRepo(set.source);
      const names = (state.cli?.[id]?.skills ?? []).filter((n) => npx[n]);
      if (!names.length) {
        skipped.push({ id, reason: "nothing installed through it; add it again with skl add if you want it" });
        continue;
      }
      if (!repo) {
        skipped.push({ id, reason: `v2 GitHub sources take owner/repo, not ${set.source}; its skills stay with npx skills` });
        continue;
      }
      sources[id] = { type: "github", repo, pick: names, ...common };
      for (const n of names) adoptedOriginals.push([id, n]);
      continue;
    }
    const installed = Object.entries(state.sets[id]?.skills ?? {}).map(([name, s]) => [s.original ?? name, name] as const);
    // Names stay as v1 had them: the namespace is the prefix, no namespace means none.
    const kept = {
      prefix: set.namespace ?? (false as const),
      ...(set.rename && Object.keys(set.rename).length ? { rename: Object.fromEntries(Object.entries(set.rename).map(([o, r]) => [o, r.to])) } : {}),
      ...(installed.length ? { pick: installed.map(([o]) => o).sort() } : {}),
      ...common,
    };
    sources[id] =
      set.type === "npm"
        ? { type: "npm", package: set.package, path: set.path, ...kept }
        : {
            type: "installer",
            command: set.command,
            ...(set.unattended ? { unattended: set.unattended } : {}),
            ...(set.secret ? { secret: set.secret } : {}),
            ...(set.stage ? { stage: set.stage } : {}),
            ...(set.harvest ? { harvest: set.harvest } : {}),
            ...kept,
          };
    for (const [o, name] of installed) replacedOriginals.push([id, o, name]);
  }

  const manifest = parseManifest({ version: 2, ...(reg.linkTargets ? { linkTargets: reg.linkTargets } : {}), sources }, paths.manifest);
  const to = (id: string, o: string) => installedName(id as SourceId, o as never, manifest.sources[id as SourceId]);
  return {
    manifest,
    replaced: replacedOriginals.map(([id, o, from]) => ({ source: id as SourceId, original: o, from, to: to(id, o) })),
    adopted: adoptedOriginals.map(([id, o]) => ({ source: id as SourceId, original: o, from: o, to: to(id, o) })),
    skipped,
  };
}

export function describePlan(plan: MigrationPlan): string[] {
  const lines: string[] = [];
  for (const [id, source] of Object.entries(plan.manifest.sources)) {
    const what = source.type === "github" ? `github ${source.repo}, now managed by skl instead of npx skills` : source.type === "npm" ? `npm ${source.package}` : "installer";
    lines.push(`${id}  (${what})`);
    const moves = [...plan.replaced, ...plan.adopted].filter((m) => m.source === id);
    const same = moves.filter((m) => m.from === m.to).length;
    if (same) lines.push(`  ${count(same, "skill")} keep their names`);
    for (const m of moves) if (m.from !== m.to) lines.push(`  ${m.from} -> ${m.to}`);
  }
  if (plan.skipped.length) lines.push("", "Not migrated:", ...plan.skipped.map((s) => `  ${s.id}: ${s.reason}`));
  if (plan.adopted.length) lines.push("", `Then npx skills removes the originals: ${plan.adopted.map((m) => m.from).join(", ")}`);
  return lines;
}

export interface MigrateOptions {
  dryRun: boolean;
  yes: boolean;
  discardEdits: boolean;
  confirm: ((question: string) => Promise<boolean>) | null;
  print: (line: string) => void;
  /** Fetch the sources; returns what failed. */
  fetch: (manifest: Manifest, paths: Paths) => { fetched: Map<SourceId, Fetched>; failed: number };
}

export async function migrate(paths: Paths, opts: MigrateOptions): Promise<number> {
  if (fs.existsSync(paths.manifest)) throw new Error(`${home(paths.manifest)} already exists; skl migrate only runs before v2 has a manifest.`);
  const files = v1Files(paths);
  if (!fs.existsSync(files.registry)) throw new Error(`No skillport v1 registry at ${home(files.registry)}; nothing to migrate.`);
  const plan = planMigration(paths);
  const v2Paths = withLinkTargets(paths, plan.manifest, paths.manifest);
  opts.print(describePlan(plan).join("\n"));
  if (opts.dryRun) {
    opts.print("\ndry run: nothing changed.");
    return 0;
  }

  // What would be lost goes first: edits made to v1's folders in place.
  const state = readV1<V1State>(files.state, { version: 1, sets: {} });
  const edited = plan.replaced.filter((m) => {
    const dir = path.join(v2Paths.skillsDir, m.from);
    const was = state.sets[m.source]?.skills[m.from]?.installed;
    return fs.existsSync(dir) && was && treeHash(dir) !== was;
  });
  if (edited.length && !opts.discardEdits) {
    throw new Error(
      `Nothing was changed: you edited ${edited.map((m) => m.from).join(", ")} in place since v1 installed them.\n  Save your changes, then run skl migrate --discard-edits (your copies go to trash).`,
    );
  }
  if (!opts.yes) {
    if (!opts.confirm) throw new Error("skl migrate needs -y without a terminal");
    if (!(await opts.confirm("Migrate to skillport v2?"))) return 0;
  }

  // The network part; a source that fails stops the run before any write.
  const { fetched, failed } = opts.fetch(plan.manifest, v2Paths);
  if (failed) throw new Error("Nothing was changed: a source could not be fetched (see above).");
  const unfetched = Object.keys(plan.manifest.sources).filter((id) => !fetched.has(id as SourceId));
  if (unfetched.length) throw new Error(`Nothing was changed: ${unfetched.join(", ")} could not be fetched.`);
  const gone = [...plan.replaced, ...plan.adopted].filter((m) => !fetched.get(m.source)?.skills.some((s) => s.original === m.original));
  if (gone.length) throw new Error(`Nothing was changed: upstream no longer ships ${gone.map((m) => `${m.source}/${m.original}`).join(", ")}.`);

  // v1's folders make way for v2's; v1's links point at the same names, so
  // sync takes them over. Anything going wrong puts v1 back.
  const trash = trashDir(v2Paths.sklDir, "migrate");
  const moved = plan.replaced.map((m) => m.from).filter((n) => fs.existsSync(path.join(v2Paths.skillsDir, n)));
  for (const n of moved) moveToTrash(trash, path.join(v2Paths.skillsDir, n));
  const stateAside = `${files.state}.v1`;
  if (fs.existsSync(files.state)) fs.renameSync(files.state, stateAside);
  let lock: Lock;
  try {
    lock = readLock(v2Paths.lockFile);
    opts.print(["", ...describeSync(sync(v2Paths, plan.manifest, lock, { fetched }))].join("\n"));
  } catch (e) {
    for (const n of moved) fs.renameSync(path.join(trash, n), path.join(v2Paths.skillsDir, n));
    if (fs.existsSync(stateAside)) fs.renameSync(stateAside, files.state);
    throw e;
  }
  writeManifest(v2Paths.manifest, plan.manifest);
  fs.renameSync(files.registry, `${files.registry}.v1`);
  opts.print(`\nWrote ${home(v2Paths.manifest)}. v1's registry and state are kept as ${home(files.registry)}.v1 and ${home(stateAside)}.`);

  if (plan.adopted.length) {
    const names = plan.adopted.map((m) => m.from);
    const question = `Remove the originals from npx skills now (${names.length} skills)? The prefixed copies are installed.`;
    if (opts.yes || (opts.confirm && (await opts.confirm(question)))) {
      removeCliSkills(v2Paths, names);
      // npx skills removes its own links; v1 linked these into your extra targets too.
      for (const dir of v2Paths.links) {
        for (const n of names) {
          const at = path.join(dir, n);
          if (!foreignInTarget(v2Paths, dir, n) && fs.lstatSync(at, { throwIfNoEntry: false }) && !fs.existsSync(at)) fs.unlinkSync(at);
        }
      }
      opts.print(`removed from npx skills: ${names.join(", ")}`);
    } else opts.print(`Kept the npx skills originals. To remove them: npx skills remove ${names.join(" ")} -g -y`);
  }
  return 0;
}
