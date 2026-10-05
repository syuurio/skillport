import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Git tree hash of a directory, computed in-process. It is the same value
// `npx skills` stores as `skillFolderHash` and GitHub returns as a directory's
// `sha`, so one comparison works for every kind of set.

// Finder metadata never comes from a vendor; hashing it would report drift.
const IGNORED = new Set([".DS_Store"]);

function objectHash(type: string, body: Buffer): Buffer {
  return createHash("sha1")
    .update(`${type} ${body.length}\0`)
    .update(body)
    .digest();
}

function treeOf(dir: string): Buffer {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !IGNORED.has(e.name))
    .map((e) => {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = Buffer.from(fs.readlinkSync(full));
        return { name: e.name, mode: "120000", hash: objectHash("blob", target), dir: false };
      }
      if (e.isDirectory()) {
        return { name: e.name, mode: "40000", hash: treeOf(full), dir: true };
      }
      const exec = (fs.statSync(full).mode & 0o111) !== 0;
      const content = fs.readFileSync(full);
      return { name: e.name, mode: exec ? "100755" : "100644", hash: objectHash("blob", content), dir: false };
    });
  // Git sorts tree entries as if directory names ended with "/".
  const key = (e: { name: string; dir: boolean }) => (e.dir ? `${e.name}/` : e.name);
  entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const body = Buffer.concat(
    entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), e.hash])),
  );
  return objectHash("tree", body);
}

export function treeHash(dir: string): string {
  return treeOf(dir).toString("hex");
}
