import fs from "node:fs";
import path from "node:path";
import type { LocalSource } from "../manifest.ts";
import { treeHash } from "../treehash.ts";
import { type Fetched, skillsIn } from "./index.ts";

/** Every child folder of the source's path that holds a SKILL.md. */
export function fetchLocal(source: LocalSource, home: string): Fetched {
  const root = source.path.startsWith("~/") ? path.join(home, source.path.slice(2)) : source.path;
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${source.path} is not a folder`);
  return { resolved: treeHash(root), skills: skillsIn(root) };
}
