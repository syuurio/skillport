import fs from "node:fs";
import path from "node:path";
import { listSkillDirs } from "../acquire.ts";
import type { SkillName, Source, SourceId } from "../manifest.ts";
import { isValidSkillName, readFrontmatterName } from "../transform.ts";
import { fetchGithub } from "./github.ts";
import { fetchInstaller } from "./installer.ts";
import { fetchLocal } from "./local.ts";
import { fetchNpm } from "./npm.ts";

// An adapter turns a source into folders under their original names. What
// happens to them afterwards (store, render, links) is the same for all.

export interface Fetched {
  /** What the lock records as `resolved`. */
  resolved: string;
  skills: { original: SkillName; dir: string }[];
}

export interface FetchOptions {
  /** Emptied first; holds vendor content until the sync is done. */
  staging: string;
  /** Hand the terminal to an installer so you answer its questions. */
  interactive: boolean;
  home: string;
  /** ~/.agents/.skl, where github sources keep their shadow HOME. */
  sklDir: string;
  /** The token for `{secret}`; read from Keychain when omitted. */
  secret?: string;
}

export function fetchSource(id: SourceId, source: Source, opts: FetchOptions): Fetched {
  switch (source.type) {
    case "local":
      return fetchLocal(source, opts.home);
    case "installer":
      return fetchInstaller(id, source, opts);
    case "npm":
      return fetchNpm(source, opts);
    case "github":
      return fetchGithub(id, source, opts);
  }
}

/**
 * Skill folders in `root`, named as their frontmatter says (else the folder).
 * The name becomes a path segment in the store, and it comes from vendor
 * content, so anything outside the Agent Skills name rules is refused.
 */
export function skillsIn(root: string): Fetched["skills"] {
  const bad: string[] = [];
  const skills = listSkillDirs(root).map((dir) => {
    const original = readFrontmatterName(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).name ?? path.basename(dir);
    if (!isValidSkillName(original)) bad.push(`${path.basename(dir)}: ${JSON.stringify(original)}`);
    return { original: original as SkillName, dir };
  });
  if (bad.length) throw new Error(`Skill names must be lowercase letters, digits and single hyphens:\n  ${bad.join("\n  ")}`);
  return skills;
}
