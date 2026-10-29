import fs from "node:fs";
import path from "node:path";
import type { SkillName, SourceId } from "./manifest.ts";
import { type Change, rewriteReferences, setFrontmatterMetadata, setFrontmatterName } from "./transform.ts";

// A vendor's skill as an agent reads it: installed name, provenance in the
// frontmatter, references to sibling skills renamed. See docs/SPEC.md §8.

export interface RenderInput {
  /** The vendor's folder, from the store. */
  from: string;
  /** Where the rendered folder goes; must not exist. */
  to: string;
  source: SourceId;
  original: SkillName;
  name: string;
  /** Original to installed name, for every skill of the same source. */
  renames: ReadonlyMap<string, string>;
}

export interface Rewrite {
  file: string;
  change: Change;
}

export function render(input: RenderInput): { rewrites: Rewrite[]; skipped: Rewrite[] } {
  fs.cpSync(input.from, input.to, { recursive: true });
  const skillMd = path.join(input.to, "SKILL.md");
  const named = setFrontmatterName(fs.readFileSync(skillMd, "utf8"), input.name);
  fs.writeFileSync(skillMd, setFrontmatterMetadata(named, { "skl-source": input.source, "skl-original": input.original }));

  const rewrites: Rewrite[] = [];
  const skipped: Rewrite[] = [];
  for (const file of markdownFiles(input.to)) {
    const r = rewriteReferences(fs.readFileSync(file, "utf8"), input.renames);
    const rel = path.join(input.name, path.relative(input.to, file));
    r.changes.forEach((change) => rewrites.push({ file: rel, change }));
    r.skipped.forEach((change) => skipped.push({ file: rel, change }));
    if (r.changes.length) fs.writeFileSync(file, r.text);
  }
  return { rewrites, skipped };
}

/** Entries that are not regular files or folders, the skill folder included. */
export function irregularEntries(dir: string): string[] {
  if (!fs.lstatSync(dir).isDirectory()) return ["."];
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => !e.isFile() && !e.isDirectory())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)));
}

export function markdownFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(e.parentPath, e.name));
}
