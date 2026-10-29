import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillsIn } from "../src/adapters/index.ts";
import { skillFlags } from "../src/check.ts";
import { type EditIO, edit } from "../src/edit.ts";
import { readLock } from "../src/lock.ts";
import { type Manifest, type SkillId, type SourceId, parseManifest } from "../src/manifest.ts";
import { defaultPaths, withLinkTargets } from "../src/registry.ts";
import { sync } from "../src/sync.ts";
import { treeHash } from "../src/treehash.ts";

const lines = (n: number, at: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => at[i + 1] ?? `line ${i + 1}`).join("\n");

/** A github source whose "repo" is a folder here; `release` hands sync what a fetch would. */
function sandbox(prefix?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-patch-"));
  const vendor = path.join(home, "vendor");
  const write = (body: string, extra: Record<string, string> = {}) => {
    fs.rmSync(vendor, { recursive: true, force: true });
    fs.mkdirSync(path.join(vendor, "alpha"), { recursive: true });
    fs.writeFileSync(path.join(vendor, "alpha", "SKILL.md"), `---\nname: alpha\ndescription: d\n---\n${body}\n`);
    for (const [f, t] of Object.entries(extra)) fs.writeFileSync(path.join(vendor, "alpha", f), t);
  };
  write(lines(20));
  const paths = withLinkTargets(defaultPaths(home), {});
  const manifestOf = (p?: string) => parseManifest({ version: 2, sources: { vend: { type: "github", repo: "v/skills", ...(p ? { prefix: p } : {}) } } }, "manifest.json");
  let manifest: Manifest = manifestOf(prefix);
  let version = 0;
  const release = () => {
    version++;
    return sync(paths, manifest, readLock(paths.lockFile), {
      fetched: new Map([["vend" as SourceId, { resolved: String(version).repeat(40), skills: skillsIn(vendor) }]]),
    });
  };
  release();
  const io = (change: (dir: string) => void, note = "Keep the house style."): EditIO => ({
    editor: (dir) => (change(dir), true),
    askNote: async () => note,
  });
  const run = (mode: "edit" | "drop" | "from-disk", change: (dir: string) => void = () => {}) =>
    edit(paths, manifest, readLock(paths.lockFile), "vend/alpha", mode, io(change));
  const installed = (name = "vend-alpha") => fs.readFileSync(path.join(paths.skillsDir, name, "SKILL.md"), "utf8");
  const setPrefix = (p: string) => (manifest = manifestOf(p));
  return { home, paths, write, release, run, installed, setPrefix, sync: () => sync(paths, manifest, readLock(paths.lockFile)) };
}

const replaceLine = (n: number, text: string) => (dir: string) => {
  const file = path.join(dir, "SKILL.md");
  const all = fs.readFileSync(file, "utf8").split("\n");
  all[n + 3] = text; // after the four frontmatter lines
  fs.writeFileSync(file, all.join("\n"));
};

test("skl edit saves a patch against the original-name folder and a note", async () => {
  const { paths, run, installed } = sandbox();
  const out = await run("edit", replaceLine(2, "line 2, mine"));
  assert.match(out.join("\n"), /saved .*\/\.config\/skl\/patches\/vend\/alpha\.patch\n/);
  const patch = fs.readFileSync(path.join(paths.patchesDir, "vend", "alpha.patch"), "utf8");
  assert.match(patch, /^diff --git a\/SKILL\.md b\/SKILL\.md/);
  assert.doesNotMatch(patch, /vend-alpha|skl-source/);
  assert.equal(fs.readFileSync(path.join(paths.patchesDir, "vend", "alpha.note.md"), "utf8"), "Keep the house style.\n");
  assert.match(installed(), /line 2, mine/);
  assert.match(installed(), /name: vend-alpha/);
  assert.ok(readLock(paths.lockFile).skills["vend/alpha" as SkillId].patch);
});

test("an upstream change elsewhere merges cleanly and keeps both", async () => {
  const { paths, write, release, run, installed, sync } = sandbox();
  await run("edit", replaceLine(2, "line 2, mine"));
  write(lines(20, { 15: "line 15, upstream" }));
  const changes = release();
  assert.deepEqual(
    changes.map((c) => c.kind === "install" && c.reapplied),
    [true],
  );
  assert.match(installed(), /line 2, mine[\s\S]*line 15, upstream/);
  // The patch was rebuilt against the new upstream, so a plain sync has nothing to do.
  assert.deepEqual(sync(), []);
  assert.doesNotMatch(fs.readFileSync(path.join(paths.patchesDir, "vend", "alpha.patch"), "utf8"), /line 15/);
});

test("an overlapping change is held back: the old output stays and the merge folder is filled", async () => {
  const { paths, write, release, run, installed } = sandbox();
  await run("edit", replaceLine(2, "line 2, mine"));
  const before = installed();
  write(lines(20, { 2: "line 2, upstream" }), { "extra.md": "new upstream file\n" });
  const changes = release();
  assert.deepEqual(
    changes.map((c) => c.kind),
    ["conflict"],
  );
  assert.equal(installed(), before);
  const merge = path.join(paths.sklDir, "merge", "vend", "alpha");
  assert.deepEqual(fs.readdirSync(merge).sort(), ["BASE", "MERGED", "UPSTREAM", "YOURS", "merge.json", "note.md", "your.patch"]);
  assert.match(fs.readFileSync(path.join(merge, "MERGED", "SKILL.md"), "utf8"), /<<<<<<< YOURS\nline 2, mine\n=======\nline 2, upstream\n>>>>>>> UPSTREAM/);
  assert.deepEqual(skillFlags(paths, readLock(paths.lockFile))["vend/alpha" as SkillId], { customized: true, conflict: merge });

  // Finishing it: skl edit starts from MERGED; the patch is then against the new upstream.
  const out = await run("edit", (dir) => {
    const file = path.join(dir, "SKILL.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/<<<<<<< YOURS\n.*\n=======\n.*\n>>>>>>> UPSTREAM\n/, "line 2, both\n"));
  });
  assert.match(out.join("\n"), /vend\/alpha -> vend-alpha/);
  assert.match(installed(), /line 2, both/);
  assert.ok(fs.existsSync(path.join(paths.skillsDir, "vend-alpha", "extra.md")));
  assert.ok(!fs.existsSync(merge));
  assert.deepEqual(release(), []);
});

test("a new prefix keeps the patched skill correct", async () => {
  const { paths, run, installed, setPrefix, sync } = sandbox();
  await run("edit", replaceLine(2, "line 2, mine"));
  setPrefix("v");
  assert.deepEqual(
    sync().map((c) => c.kind),
    ["install"],
  );
  assert.ok(!fs.existsSync(path.join(paths.skillsDir, "vend-alpha")));
  assert.match(installed("v-alpha"), /name: v-alpha[\s\S]*line 2, mine/);
});

test("--from-disk turns edits made in place into a patch that renders back to exactly that folder", async () => {
  const { paths, run, installed, sync } = sandbox();
  const dest = path.join(paths.skillsDir, "vend-alpha");
  replaceLine(5, "line 5, edited in place")(dest);
  fs.writeFileSync(path.join(dest, "notes.md"), "mine\n");
  const edited = treeHash(dest);
  assert.deepEqual(
    sync().map((c) => c.kind),
    ["edited"],
  );
  await run("from-disk");
  assert.equal(treeHash(dest), edited);
  assert.equal(readLock(paths.lockFile).skills["vend/alpha" as SkillId].output, edited);
  assert.deepEqual(sync(), []);
  // Rendered from scratch, base plus the patch is the same folder.
  fs.rmSync(dest, { recursive: true });
  sync();
  assert.equal(treeHash(dest), edited);
  assert.match(installed(), /line 5, edited in place/);
});

test("--from-disk refuses edits to lines skl rewrites", async () => {
  const { paths, run } = sandbox();
  const file = path.join(paths.skillsDir, "vend-alpha", "SKILL.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("name: vend-alpha", "name: vend-alpha-2"));
  await assert.rejects(run("from-disk"), /Could not turn the edits to vend-alpha into a patch/);
  assert.ok(!fs.existsSync(path.join(paths.patchesDir, "vend", "alpha.patch")));
});

test("skl edit refuses a skill changed in place, and --drop restores upstream", async () => {
  const { paths, run, installed } = sandbox();
  await run("edit", replaceLine(2, "line 2, mine"));
  fs.appendFileSync(path.join(paths.skillsDir, "vend-alpha", "SKILL.md"), "x\n");
  await assert.rejects(run("edit"), /changed in place[\s\S]*--from-disk/);
  fs.writeFileSync(path.join(paths.skillsDir, "vend-alpha", "SKILL.md"), installed().replace(/x\n$/, ""));
  const out = await run("drop");
  assert.match(out.join("\n"), /dropped the patch for vend\/alpha/);
  assert.doesNotMatch(installed(), /mine/);
  assert.ok(!fs.existsSync(path.join(paths.patchesDir, "vend", "alpha.patch")));
  assert.equal(readLock(paths.lockFile).skills["vend/alpha" as SkillId].patch, undefined);
});

test("--from-disk takes an edit right next to a rewritten reference", async () => {
  const { paths, write, release, run, sync } = sandbox();
  write(`${lines(5)}\nWhen done, use the \`alpha\` skill again.`);
  release();
  const dest = path.join(paths.skillsDir, "vend-alpha");
  assert.match(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"), /use the `vend-alpha` skill again\.\n$/);
  fs.appendFileSync(path.join(dest, "SKILL.md"), "- Also log the result.\n");
  const edited = treeHash(dest);
  await run("from-disk");
  const patch = fs.readFileSync(path.join(paths.patchesDir, "vend", "alpha.patch"), "utf8");
  assert.match(patch, /\+- Also log the result\./);
  assert.doesNotMatch(patch, /vend-alpha/);
  assert.deepEqual(sync(), []);
  assert.equal(treeHash(dest), edited);
});
