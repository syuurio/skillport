import fs from "node:fs";
import path from "node:path";
import type { SkillName, SourceId } from "./manifest.ts";
import type { Paths } from "./registry.ts";
import { irregularEntries } from "./render.ts";
import { treeHash } from "./treehash.ts";

// Vendor content as shipped, under its original name, one folder per tree
// hash. A hash folder is never changed once written, so the lock's `base`
// always names exactly what was installed. See docs/SPEC-v2.md §5.3.

export function storedAt(paths: Paths, source: SourceId, original: SkillName, hash: string): string {
  return path.join(paths.storeDir, source, original, hash);
}

/** Copy a vendor skill folder into the store; returns its tree hash. */
export function putInStore(paths: Paths, source: SourceId, original: SkillName, dir: string): string {
  // Vendor content is untrusted: a symlink could pull any file on this
  // machine into a skill every agent reads.
  const odd = irregularEntries(dir);
  if (odd.length) throw new Error(`${source}/${original} contains entries skl does not install (only regular files and folders): ${odd.join(", ")}`);
  const parent = path.join(paths.storeDir, source, original);
  fs.mkdirSync(parent, { recursive: true });
  // Hash the copy, not the original, so what is stored is what was hashed.
  const tmp = fs.mkdtempSync(path.join(parent, ".tmp-"));
  try {
    fs.cpSync(dir, tmp, { recursive: true });
    const hash = treeHash(tmp);
    const dest = path.join(parent, hash);
    if (!fs.existsSync(dest)) fs.renameSync(tmp, dest);
    return hash;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
