import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copySkips } from "../src/adapters/github.ts";
import { type GitEntry, treeHash, treeHashOfListing } from "../src/treehash.ts";

function gitTreeHash(dir: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-git-"));
  fs.cpSync(dir, path.join(repo, "x"), { recursive: true, verbatimSymlinks: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", "-A");
  return git("rev-parse", `${git("write-tree")}:x`);
}

test("treeHash matches git for files, nesting, exec bits, symlinks and ordering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-th-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: a\n---\n");
  fs.mkdirSync(path.join(dir, "refs"));
  fs.writeFileSync(path.join(dir, "refs", "x.md"), "x");
  // "refs" (dir) vs "refs.md" (file) exercises git's dir-as-"name/" ordering.
  fs.writeFileSync(path.join(dir, "refs.md"), "y");
  fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\n");
  fs.chmodSync(path.join(dir, "run.sh"), 0o755);
  fs.symlinkSync("refs/x.md", path.join(dir, "link"));
  assert.equal(treeHash(dir), gitTreeHash(dir));
});

test("treeHash ignores .DS_Store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-th-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "a");
  const before = treeHash(dir);
  fs.writeFileSync(path.join(dir, ".DS_Store"), "junk");
  assert.equal(treeHash(dir), before);
});

test("treeHashOfListing hashes a git listing as the folder npx skills copies", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-ls-"));
  const skill = path.join(repo, "skills", "a");
  fs.mkdirSync(path.join(skill, "__pycache__"), { recursive: true });
  fs.mkdirSync(path.join(skill, "scripts", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: a\n---\n");
  fs.writeFileSync(path.join(skill, "metadata.json"), "{}");
  fs.writeFileSync(path.join(skill, "__pycache__", "x.pyc"), "x");
  fs.writeFileSync(path.join(skill, "scripts", "run.py"), "print(1)");
  fs.writeFileSync(path.join(skill, "scripts", "__pycache__", "run.pyc"), "x");
  fs.chmodSync(path.join(skill, "scripts", "run.py"), 0o755);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", "-A");
  const listing: GitEntry[] = git("ls-tree", "-r", "-t", git("write-tree"))
    .split("\n")
    .map((line) => {
      const [meta, p] = line.split("\t");
      const [mode, type, sha] = meta.split(" ");
      return { path: p, mode, type, sha };
    });
  const copied = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-cp-"));
  fs.cpSync(skill, copied, { recursive: true, filter: (src) => !copySkips(path.basename(src), fs.statSync(src).isDirectory()) });
  assert.equal(treeHashOfListing(listing, "skills/a", copySkips), treeHash(copied));
  assert.notEqual(treeHashOfListing(listing, "skills/a", () => false), treeHash(copied));
});
