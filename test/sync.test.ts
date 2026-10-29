import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readLock } from "../src/lock.ts";
import { type Manifest, type Source, type SourceId, parseManifest } from "../src/manifest.ts";
import { defaultPaths, withLinkTargets } from "../src/paths.ts";
import { describeSync, sync } from "../src/sync.ts";

const fixtures = path.join(import.meta.dirname, "fixtures", "v2", "local");

function sandbox(fx: Partial<Source> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-sync-"));
  const src = path.join(home, "src");
  fs.cpSync(fixtures, src, { recursive: true });
  const manifest = (extra: Partial<Source> = fx): Manifest =>
    parseManifest({ version: 2, sources: { fx: { type: "local", path: src, ...extra } } }, "manifest.json");
  const paths = withLinkTargets(defaultPaths(home), {});
  const run = (m = manifest()) => describeSync(sync(paths, m, readLock(paths.lockFile), { now: "2026-10-29T08:00:00.000Z" }));
  const trashed = () => {
    const trash = path.join(paths.sklDir, "trash");
    return fs.existsSync(trash) ? fs.readdirSync(trash).flatMap((t) => fs.readdirSync(path.join(trash, t))) : [];
  };
  return { home, src, paths, manifest, run, trashed };
}

const ls = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

test("sync installs prefixed skills and links them for Claude Code", () => {
  const { paths, run } = sandbox();
  assert.deepEqual(run(), [
    "fx/alpha -> fx-alpha",
    "  fx-alpha/SKILL.md:11: `beta` -> `fx-beta`",
    "fx/beta -> fx-beta",
    "  fx-beta/SKILL.md:10: `alpha` -> `fx-alpha`",
    "  fx-beta/references/steps.md:3: `alpha` -> `fx-alpha`",
  ]);
  assert.deepEqual(ls(paths.skillsDir), ["fx-alpha", "fx-beta"]);
  const claude = paths.linkTargets["claude-code"];
  assert.equal(fs.readlinkSync(path.join(claude, "fx-alpha")), path.join(paths.skillsDir, "fx-alpha"));
  const lock = readLock(paths.lockFile);
  assert.deepEqual(lock.sources["fx" as SourceId].seen, ["alpha", "beta"]);
  assert.equal(Object.values(lock.skills).map((s) => s.name).join(), "fx-alpha,fx-beta");
});

test("a second sync writes nothing", () => {
  const { paths, run } = sandbox();
  run();
  const lockBefore = fs.statSync(paths.lockFile).mtimeMs;
  const dirBefore = fs.statSync(path.join(paths.skillsDir, "fx-alpha")).ino;
  assert.deepEqual(run(), []);
  assert.equal(fs.statSync(paths.lockFile).mtimeMs, lockBefore);
  assert.equal(fs.statSync(path.join(paths.skillsDir, "fx-alpha")).ino, dirBefore);
});

test("a prefix change moves old names to trash and creates new ones", () => {
  const { paths, manifest, run, trashed } = sandbox();
  run();
  const lines = run(manifest({ prefix: "f" }));
  assert.ok(lines.includes("fx/alpha -> f-alpha"), lines.join("\n"));
  assert.deepEqual(ls(paths.skillsDir), ["f-alpha", "f-beta"]);
  assert.deepEqual(ls(paths.linkTargets["claude-code"]), ["f-alpha", "f-beta"]);
  assert.deepEqual(trashed().sort(), ["fx-alpha", "fx-beta"]);
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "f-beta", "SKILL.md"), "utf8"), /The `f-alpha` skill/);
});

test("excluding a skill removes it and stops rewriting references to it", () => {
  const { paths, manifest, run } = sandbox();
  run();
  assert.deepEqual(run(manifest({ exclude: ["beta"] })), ["removed fx-beta (fx/beta)", "fx/alpha -> fx-alpha"]);
  assert.deepEqual(ls(paths.linkTargets["claude-code"]), ["fx-alpha"]);
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "fx-alpha", "SKILL.md"), "utf8"), /use the `beta` skill/);
});

test("an upstream edit replaces only that folder", () => {
  const { src, paths, run, trashed } = sandbox();
  run();
  fs.appendFileSync(path.join(src, "alpha", "SKILL.md"), "\nMore.\n");
  assert.deepEqual(run(), ["fx/alpha -> fx-alpha", "  fx-alpha/SKILL.md:11: `beta` -> `fx-beta`"]);
  assert.deepEqual(trashed(), ["fx-alpha"]);
  assert.equal(ls(path.join(paths.storeDir, "fx", "alpha")).length, 2);
});

test("links: [] installs without linking", () => {
  const { paths, run } = sandbox({ links: [] });
  run();
  assert.deepEqual(ls(paths.linkTargets["claude-code"]), []);
  assert.deepEqual(ls(paths.skillsDir), ["fx-alpha", "fx-beta"]);
});

test("sync refuses to replace a folder or link skl did not create, and changes nothing", () => {
  const { paths, run } = sandbox();
  fs.mkdirSync(path.join(paths.skillsDir, "fx-alpha"), { recursive: true });
  assert.throws(() => run(), /fx\/alpha would install as "fx-alpha", which is taken by a folder in ~\/.agents\/skills that skl did not install\.\n {4}Fix: skl rename fx\/alpha <new-name>$/m);
  assert.deepEqual(ls(paths.skillsDir), ["fx-alpha"]);
  assert.equal(fs.existsSync(paths.lockFile), false);
});

test("a new folder in a local source is installed on the next sync", () => {
  const { src, paths, run } = sandbox();
  run();
  fs.mkdirSync(path.join(src, "gamma"));
  fs.writeFileSync(path.join(src, "gamma", "SKILL.md"), "---\nname: gamma\ndescription: d\n---\n");
  assert.deepEqual(run(), ["fx/gamma -> fx-gamma"]);
  assert.deepEqual(ls(paths.skillsDir), ["fx-alpha", "fx-beta", "fx-gamma"]);
});

test("a skill you changed in place is kept, reported, and replaced only with discardEdits", () => {
  const { paths, manifest, run, trashed } = sandbox();
  run();
  const alpha = path.join(paths.skillsDir, "fx-alpha", "SKILL.md");
  fs.appendFileSync(alpha, "\nMine.\n");
  const held = ["edited fx-alpha (fx/alpha) was changed in place; kept as is", "  to replace it with skl's version: skl sync --discard-edits"];
  assert.deepEqual(run(), held);
  assert.match(fs.readFileSync(alpha, "utf8"), /Mine\./);

  const renamed = run(manifest({ prefix: "f" }));
  assert.deepEqual(renamed.slice(0, 2), held);
  assert.ok(renamed.includes("fx/beta -> f-beta"), renamed.join("\n"));
  assert.deepEqual(ls(paths.skillsDir), ["f-beta", "fx-alpha"]);
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "f-beta", "SKILL.md"), "utf8"), /The `fx-alpha` skill/);

  const replaced = describeSync(sync(paths, manifest({ prefix: "f" }), readLock(paths.lockFile), { discardEdits: true }));
  assert.ok(replaced.includes("fx/alpha -> f-alpha"), replaced.join("\n"));
  assert.deepEqual(ls(paths.skillsDir), ["f-alpha", "f-beta"]);
  assert.ok(trashed().includes("fx-alpha"));
});

test("a new skill whose name is taken is held back alone; the rest still syncs", () => {
  const { src, paths, run } = sandbox();
  run();
  fs.mkdirSync(path.join(src, "gamma"));
  fs.writeFileSync(path.join(src, "gamma", "SKILL.md"), "---\nname: gamma\ndescription: g\n---\nG.\n");
  fs.appendFileSync(path.join(src, "alpha", "SKILL.md"), "\nUpstream.\n");
  fs.mkdirSync(path.join(paths.skillsDir, "fx-gamma"));
  fs.writeFileSync(path.join(paths.skillsDir, "fx-gamma", "SKILL.md"), "not skl's\n");
  const out = run();
  assert.match(out.join("\n"), /^blocked fx\/gamma would install as "fx-gamma", which is taken by a folder/);
  assert.ok(out.includes("fx/alpha -> fx-alpha"));
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "fx-alpha", "SKILL.md"), "utf8"), /Upstream\./);
  assert.equal(fs.readFileSync(path.join(paths.skillsDir, "fx-gamma", "SKILL.md"), "utf8"), "not skl's\n");
  // Not installed, so not seen: it is reported again until the name is fixed.
  assert.ok(!readLock(paths.lockFile).sources["fx" as SourceId].seen.includes("gamma"));
  assert.match(run().join("\n"), /^blocked fx\/gamma/);
});
