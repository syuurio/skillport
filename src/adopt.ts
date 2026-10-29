import path from "node:path";
import { fetchSource } from "./adapters/index.ts";
import type { Lock } from "./lock.ts";
import { type GithubSource, type Manifest, type SourceId, parseManifest, writeManifest } from "./manifest.ts";
import { confirm, isInteractive } from "./prompt.ts";
import type { Paths } from "./registry.ts";
import { removeCliSkills } from "./skillscli.ts";
import { readSkillLock } from "./state.ts";
import { sync } from "./sync.ts";
import { githubRepo } from "./validate.ts";

// `skl adopt <owner/repo>`: take over skills you installed with plain
// `npx skills`. The prefixed copies are installed first; the originals are
// removed through npx skills only after that succeeded (SPEC §9).

export interface AdoptOptions {
  /** Source id; defaults to the repo owner. */
  id?: string;
  yes: boolean;
}

/** `mattpocock/skills` → `mattpocock`, in source-id form. */
export function defaultSourceId(repo: string): string {
  return repo.split("/")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function adopt(paths: Paths, manifest: Manifest, lock: Lock, from: string, opts: AdoptOptions): Promise<string[]> {
  const repo = githubRepo(from);
  if (!repo) throw new Error(`"${from}" is not a GitHub repo; adopt takes owner/repo or a GitHub URL`);
  const external = Object.entries(readSkillLock(paths.skillLock));
  const names = external.filter(([, e]) => githubRepo(e.sourceUrl ?? e.source) === repo).map(([name]) => name).sort();
  if (!names.length) {
    const sources = [...new Set(external.map(([, e]) => e.source))].sort().join(", ") || "(none)";
    throw new Error(`npx skills has nothing installed from ${repo}. Its sources: ${sources}`);
  }
  const twin = Object.entries(manifest.sources).find(([, s]) => s.type === "github" && githubRepo(s.repo) === repo);
  if (twin) throw new Error(`${repo} is already sources.${twin[0]}; to install more of it: skl update ${twin[0]} --pick`);
  const id = (opts.id ?? defaultSourceId(repo)) as SourceId;
  if (manifest.sources[id]) throw new Error(`sources.${id} already exists; choose another id with --as <id>`);

  const source: GithubSource = { type: "github", repo, pick: names };
  const next = parseManifest({ ...manifest, sources: { ...manifest.sources, [id]: source } }, paths.manifest);
  const staging = path.join(paths.sklDir, "fetch", id);
  const fetched = fetchSource(id, next.sources[id], { staging, interactive: false, home: paths.home, sklDir: paths.sklDir });
  const missing = names.filter((n) => !fetched.skills.some((s) => s.original === n));
  if (missing.length) throw new Error(`${repo} no longer ships ${missing.join(", ")}; nothing was changed. Remove them with npx skills, then adopt again.`);
  const lines = sync(paths, next, lock, { fetched: new Map([[id, fetched]]) });
  writeManifest(paths.manifest, next);

  // A real delete, so it is the last step and asks first.
  const question = `Remove the originals from npx skills now (${names.join(", ")})? The prefixed copies are installed.`;
  if (!opts.yes && !(isInteractive() && (await confirm(question, true)))) {
    return [...lines, `Kept the npx skills originals. To remove them: npx skills remove ${names.join(" ")} -g -y`];
  }
  removeCliSkills(paths, names);
  const left = names.filter((n) => n in readSkillLock(paths.skillLock));
  if (left.length) throw new Error(`npx skills still lists ${left.join(", ")}; remove them by hand: npx skills remove ${left.join(" ")} -g -y`);
  return [...lines, `removed from npx skills: ${names.join(", ")}`];
}
