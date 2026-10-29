import fs from "node:fs";
import path from "node:path";
import { listSkillDirs } from "../acquire.ts";
import type { LocalSource, SkillName } from "../manifest.ts";
import { readFrontmatterName } from "../transform.ts";
import { treeHash } from "../treehash.ts";

export interface Fetched {
  /** What the lock records as `resolved`. */
  resolved: string;
  skills: { original: SkillName; dir: string }[];
}

/** Every child folder of the source's path that holds a SKILL.md. */
export function fetchLocal(source: LocalSource, home: string): Fetched {
  const root = source.path.startsWith("~/") ? path.join(home, source.path.slice(2)) : source.path;
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${source.path} is not a folder`);
  const skills = listSkillDirs(root).map((dir) => {
    const fm = readFrontmatterName(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).name;
    return { original: (fm ?? path.basename(dir)) as SkillName, dir };
  });
  return { resolved: treeHash(root), skills };
}
