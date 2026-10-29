import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "./fsutil.ts";

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
  const entries: TreeItem[] = fs
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
  return treeObject(entries);
}

interface TreeItem {
  name: string;
  mode: string;
  hash: Buffer;
  dir: boolean;
}

function treeObject(entries: TreeItem[]): Buffer {
  // Git sorts tree entries as if directory names ended with "/".
  const key = (e: { name: string; dir: boolean }) => (e.dir ? `${e.name}/` : e.name);
  entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const body = Buffer.concat(
    entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), e.hash])),
  );
  return objectHash("tree", body);
}

/** One row of a recursive git tree listing, as GitHub's trees API returns it. */
export interface GitEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

/**
 * The tree hash `dir` would have once copied with `skip`'s entries left out,
 * computed from a recursive listing's blob hashes alone. npx skills drops
 * some files when it copies (metadata.json, .git, ...), so GitHub's own sha
 * for the folder never matches the copy when they are present. Null when
 * `dir` is not in the listing or holds a submodule.
 */
export function treeHashOfListing(listing: GitEntry[], dir: string, skip: (name: string, isDir: boolean) => boolean): string | null {
  const children = new Map<string, GitEntry[]>();
  const prefix = dir === "." ? "" : `${dir}/`;
  for (const e of listing) {
    if (!e.path.startsWith(prefix)) continue;
    const parent = path.posix.dirname(e.path.slice(prefix.length));
    children.set(parent, [...(children.get(parent) ?? []), e]);
  }
  if (!children.size) return null;
  const treeAt = (rel: string): Buffer | null => {
    const items: TreeItem[] = [];
    for (const e of children.get(rel) ?? []) {
      const name = path.posix.basename(e.path);
      const isDir = e.type === "tree";
      if (IGNORED.has(name) || skip(name, isDir)) continue;
      if (e.type === "commit") return null;
      const hash = isDir ? treeAt(rel === "." ? name : `${rel}/${name}`) : Buffer.from(e.sha, "hex");
      if (!hash) return null;
      items.push({ name, mode: isDir ? "40000" : e.mode, hash, dir: isDir });
    }
    return treeObject(items);
  };
  return treeAt(".")?.toString("hex") ?? null;
}

export function treeHash(dir: string): string {
  return treeOf(dir).toString("hex");
}

/**
 * Tree hash with some top-level entries left out. For telling whether a copy
 * a vendor left in an agent folder is the same skill: installers add per-agent
 * files (Emil's add `agents/openai.yaml` for Codex) that skillport's copy does
 * not have.
 */
export function treeHashWithout(dir: string, skip: string[]): string {
  return withTempDir("th", (tmp) => {
    for (const e of fs.readdirSync(dir)) {
      if (!skip.includes(e)) fs.cpSync(path.join(dir, e), path.join(tmp, e), { recursive: true, verbatimSymlinks: true });
    }
    return treeHash(tmp);
  });
}

/**
 * Top-level entries installers add for one agent: Emil's installers write
 * `agents/openai.yaml` for Codex (verified). Only an `agents` folder holding
 * nothing but that file qualifies, and only when our copy has no `agents`.
 */
function agentExtras(copy: string, ours: string): string[] {
  if (fs.existsSync(path.join(ours, "agents"))) return [];
  const agents = path.join(copy, "agents");
  const st = fs.lstatSync(agents, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return [];
  const inside = fs.readdirSync(agents);
  return inside.length === 1 && inside[0] === "openai.yaml" ? ["agents"] : [];
}

/**
 * Whether `copy` is the same skill as our folder `ours`: its tree hash is one
 * of `hashes` (by default, our folder's), exactly or once the per-agent files
 * an installer adds are left out. Anything else you added makes it different.
 */
export function sameSkill(copy: string, ours: string, hashes: string[] = [treeHash(ours)]): boolean {
  if (hashes.includes(treeHash(copy))) return true;
  const extras = agentExtras(copy, ours);
  return extras.length > 0 && hashes.includes(treeHashWithout(copy, extras));
}
