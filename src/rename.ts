import fs from "node:fs";
import path from "node:path";
import type { Lock } from "./lock.ts";
import { type Manifest, type SkillId, parseManifest, splitSkillId, writeManifest } from "./manifest.ts";
import type { Paths } from "./paths.ts";
import { describeSync, sync } from "./sync.ts";
import { isValidSkillName } from "./transform.ts";

// `skl rename <source>/<skill> <name>`: give one skill its own install name,
// the fix skl prints for a name clash. Writes `rename` in the manifest only
// once the sync with it went through.

export function renameSkill(paths: Paths, manifest: Manifest, lock: Lock, arg: string | undefined, name: string | undefined): string[] {
  if (!arg?.includes("/") || !name) throw new Error("Usage: skl rename <source>/<skill> <new-name>");
  const id = arg as SkillId;
  const { source, original } = splitSkillId(id);
  const entry = manifest.sources[source];
  if (!entry) throw new Error(`Unknown source ${source}. Known: ${Object.keys(manifest.sources).join(", ")}`);
  if (!isValidSkillName(name)) throw new Error(`"${name}" is not a valid skill name (a-z, 0-9, single hyphens, at most 64)`);
  // A skill held back for its name was fetched into the store, though not installed.
  if (!lock.skills[id] && !fs.existsSync(path.join(paths.storeDir, source, original))) throw new Error(`${source} has no skill named ${original}`);
  const next = parseManifest({ ...manifest, sources: { ...manifest.sources, [source]: { ...entry, rename: { ...entry.rename, [original]: name } } } }, paths.manifest);
  const lines = describeSync(sync(paths, next, lock));
  writeManifest(paths.manifest, next);
  lines.push(`Set sources.${source}.rename.${original} to "${name}" in the manifest`);
  if (!lock.skills[id]) lines.push(`${id} is not installed yet; install it with: skl update ${source}`);
  return lines;
}
