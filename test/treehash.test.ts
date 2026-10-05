import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { treeHash } from "../src/treehash.ts";

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
