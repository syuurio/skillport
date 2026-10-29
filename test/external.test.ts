import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readLock } from "../src/lock.ts";
import { parseManifest } from "../src/manifest.ts";
import { defaultPaths, withLinkTargets } from "../src/paths.ts";
import { sync } from "../src/sync.ts";
import { treeHash } from "../src/treehash.ts";

const fixtures = path.join(import.meta.dirname, "fixtures", "v2", "local");

/** A sandbox HOME whose npx skills already installed `alpha`, unprefixed. */
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-external-"));
  const paths = withLinkTargets(defaultPaths(home), {});
  fs.mkdirSync(path.join(paths.skillsDir, "alpha"), { recursive: true });
  fs.writeFileSync(path.join(paths.skillsDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: npx\n---\n");
  const entry = { source: "someone/skills", sourceType: "github", skillPath: "alpha/SKILL.md", skillFolderHash: "x", updatedAt: "" };
  fs.writeFileSync(paths.skillLock, JSON.stringify({ version: 3, skills: { alpha: entry } }));
  const manifest = (extra: object = {}) =>
    parseManifest({ version: 2, sources: { fx: { type: "local", path: fixtures, ...extra } } }, "manifest.json");
  return { home, paths, manifest };
}

test("prefix false colliding with an npx skills install stops before anything is written", () => {
  const { home, paths, manifest } = sandbox();
  const before = treeHash(home);
  assert.throws(
    () => sync(paths, manifest({ prefix: false }), readLock(paths.lockFile)),
    /fx\/alpha would install as "alpha", which is taken by an external npx skills install \(someone\/skills\)\.\n {4}Fix: skl rename fx\/alpha fx-alpha$/m,
  );
  // The store may hold the fetched copy; nothing an agent reads changed.
  fs.rmSync(paths.sklDir, { recursive: true, force: true });
  assert.equal(treeHash(home), before);
});

test("the default prefix avoids the npx skills install, which stays untouched", () => {
  const { paths, manifest } = sandbox();
  const lockBefore = fs.readFileSync(paths.skillLock, "utf8");
  sync(paths, manifest(), readLock(paths.lockFile));
  assert.deepEqual(fs.readdirSync(paths.skillsDir).sort(), ["alpha", "fx-alpha", "fx-beta"]);
  assert.equal(fs.readFileSync(paths.skillLock, "utf8"), lockBefore);
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "alpha", "SKILL.md"), "utf8"), /description: npx/);
});

test("a real folder in a link target stops the run", () => {
  const { paths, manifest } = sandbox();
  fs.mkdirSync(path.join(paths.linkTargets["claude-code"], "fx-beta"), { recursive: true });
  assert.throws(() => sync(paths, manifest(), readLock(paths.lockFile)), /fx\/beta would link .*\.claude\/skills\/fx-beta, which skl did not create\./);
  assert.equal(fs.existsSync(path.join(paths.skillsDir, "fx-alpha")), false);
});

test("doctor reports drift and fixes only the safe parts", async () => {
  const { diagnose } = await import("../src/doctor.ts");
  const { paths, manifest } = sandbox();
  const m = manifest();
  sync(paths, m, readLock(paths.lockFile));
  const claude = paths.linkTargets["claude-code"];
  const codex = path.join(paths.home, ".codex", "skills");
  fs.appendFileSync(path.join(paths.skillsDir, "fx-beta", "SKILL.md"), "\nMine.\n");
  fs.unlinkSync(path.join(claude, "fx-alpha"));
  fs.symlinkSync(path.join(paths.skillsDir, "gone"), path.join(claude, "gone"));
  fs.cpSync(path.join(fixtures, "alpha"), path.join(codex, "alpha"), { recursive: true });
  fs.cpSync(path.join(fixtures, "beta"), path.join(codex, "beta"), { recursive: true });
  fs.appendFileSync(path.join(codex, "beta", "SKILL.md"), "other\n");
  fs.mkdirSync(path.join(paths.patchesDir, "fx"), { recursive: true });
  fs.writeFileSync(path.join(paths.patchesDir, "fx", "alpha.patch"), "");
  fs.mkdirSync(path.join(paths.skillsDir, "mine"));

  const findings = diagnose(paths, m, readLock(paths.lockFile));
  const summary = findings.map((f) => `${f.fix ? "fix" : "report"} ${f.kind} ${path.basename(f.message.split(" ")[0])}`).sort();
  assert.deepEqual(summary, [
    "fix broken-link gone",
    "fix missing-link fx-alpha",
    "fix stray-copy alpha",
    "report edited fx-beta",
    "report no-note alpha.patch",
    "report stray-copy beta",
    "report unowned mine",
  ]);

  for (const f of findings) f.fix?.();
  assert.equal(fs.readlinkSync(path.join(claude, "fx-alpha")), path.join(paths.skillsDir, "fx-alpha"));
  assert.equal(fs.existsSync(path.join(claude, "gone")), false);
  assert.deepEqual(fs.readdirSync(codex), ["beta"]);
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "fx-beta", "SKILL.md"), "utf8"), /Mine\./);
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "alpha", "SKILL.md"), "utf8"), /description: npx/);
});
