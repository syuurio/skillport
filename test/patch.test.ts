import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillsIn } from "../src/adapters/index.ts";
import { skillFlags } from "../src/check.ts";
import { edit } from "../src/edit.ts";
import { readLock } from "../src/lock.ts";
import { type Manifest, type SkillId, type SourceId, parseManifest } from "../src/manifest.ts";
import { defaultPaths, withLinkTargets } from "../src/paths.ts";
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
  const opts = { askNote: async () => "Keep the house style." };
  // "edit" is how you or an agent customize now: change the installed folder
  // and take it from disk, or resolve MERGED and finish the merge.
  const run = (mode: "edit" | "drop" | "from-disk", change: (dir: string) => void = () => {}) => {
    const lock = readLock(paths.lockFile);
    if (mode !== "edit") return edit(paths, manifest, lock, "vend/alpha", mode, opts);
    const merged = path.join(paths.sklDir, "merge", "vend", "alpha", "MERGED");
    if (fs.existsSync(merged)) {
      change(merged);
      return edit(paths, manifest, lock, "vend/alpha", "finish", opts);
    }
    const name = lock.skills["vend/alpha" as SkillId].name;
    change(path.join(paths.skillsDir, name));
    return edit(paths, manifest, lock, "vend/alpha", "from-disk", opts);
  };
  const installed = (name = "vend-alpha") => fs.readFileSync(path.join(paths.skillsDir, name, "SKILL.md"), "utf8");
  const setPrefix = (p: string) => (manifest = manifestOf(p));
  return { home, paths, write, release, run, installed, setPrefix, sync: () => sync(paths, manifest, readLock(paths.lockFile)) };
}

const replaceLine = (n: number, text: string) => (dir: string) => {
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(new RegExp(`^line ${n}(,.*)?$`, "m"), text));
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
  assert.ok(!fs.existsSync(path.join(paths.sklDir, "merge")), "no empty merge folders left behind");
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

test("plain skl edit only finishes a merge; it points elsewhere at --from-disk, and --drop restores upstream", async () => {
  const { paths, run, installed } = sandbox();
  await run("edit", replaceLine(2, "line 2, mine"));
  const finish = () => edit(paths, parseManifest({ version: 2, sources: { vend: { type: "github", repo: "v/skills" } } }, "m"), readLock(paths.lockFile), "vend/alpha", "finish", { askNote: async () => "" });
  await assert.rejects(finish(), /vend\/alpha has no merge to finish\. To customize it, change .*vend-alpha, then run:\n {2}skl edit vend\/alpha --from-disk --note "<why>"/);
  fs.appendFileSync(path.join(paths.skillsDir, "vend-alpha", "SKILL.md"), "x\n");
  await assert.rejects(finish(), /changed in place[\s\S]*--from-disk/);
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

test("applying a patch ignores a .git that came with the vendor's content", async () => {
  const { paths, write, release, run, installed } = sandbox();
  write(lines(20));
  // Run inside the folder, git would take this as its repository and fail on it.
  fs.writeFileSync(path.join(paths.home, "vendor", "alpha", ".git"), "gitdir: /nonexistent/skl-test\n");
  release();
  await run("edit", replaceLine(2, "line 2, mine"));
  assert.match(installed(), /line 2, mine/);
});

test("a patch reaching outside the skill is refused", async () => {
  const { applyPatch } = await import("../src/patch.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skl-unsafe-"));
  const evil = "diff --git a/../x b/../x\nnew file mode 100644\n--- /dev/null\n+++ b/../x\n@@ -0,0 +1 @@\n+x\n";
  assert.throws(() => applyPatch(dir, evil), /paths or modes skl does not apply/);
  const link = "diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n";
  assert.throws(() => applyPatch(dir, link), /paths or modes skl does not apply/);
});

test("on a new machine a patch that no longer applies waits in MERGED, and skl edit installs it", async () => {
  const { paths, write, release, run, installed } = sandbox();
  await run("edit", (dir) => {
    replaceLine(2, "line 2, mine")(dir);
    replaceLine(18, "line 18, mine")(dir);
  });
  // A new machine has only ~/.config/skl, and upstream has moved on since.
  fs.rmSync(paths.sklDir, { recursive: true });
  fs.rmSync(paths.skillsDir, { recursive: true });
  write(lines(20, { 2: "line 2, upstream" }));
  const changes = release();
  assert.deepEqual(
    changes.map((c) => c.kind === "conflict" && c.files),
    [["SKILL.md.rej"]],
  );
  assert.ok(!fs.existsSync(path.join(paths.skillsDir, "vend-alpha")));
  const merged = path.join(paths.sklDir, "merge", "vend", "alpha", "MERGED");
  assert.match(fs.readFileSync(path.join(merged, "SKILL.md"), "utf8"), /line 2, upstream[\s\S]*line 18, mine/);

  await assert.rejects(run("edit"), /Apply the hunks in SKILL\.md\.rej by hand/);
  const out = await run("edit", (dir) => {
    replaceLine(2, "line 2, upstream and mine")(dir);
    fs.rmSync(path.join(dir, "SKILL.md.rej"));
  });
  assert.match(out.join("\n"), /vend\/alpha -> vend-alpha/);
  assert.match(installed(), /line 2, upstream and mine[\s\S]*line 18, mine/);
  assert.deepEqual(release(), []);
});

test("--note writes the note without asking, and replaces an earlier one", async () => {
  const { paths } = sandbox();
  const manifest = parseManifest({ version: 2, sources: { vend: { type: "github", repo: "v/skills" } } }, "m");
  const fromDisk = (note: string) =>
    edit(paths, manifest, readLock(paths.lockFile), "vend/alpha", "from-disk", { note, askNote: () => assert.fail("asked for a note") });
  const note = path.join(paths.patchesDir, "vend", "alpha.note.md");
  replaceLine(2, "line 2, mine")(path.join(paths.skillsDir, "vend-alpha"));
  await fromDisk("Use our tone.");
  assert.equal(fs.readFileSync(note, "utf8"), "Use our tone.\n");
  replaceLine(3, "line 3, mine")(path.join(paths.skillsDir, "vend-alpha"));
  await fromDisk("Use our tone, and our terms.");
  assert.equal(fs.readFileSync(note, "utf8"), "Use our tone, and our terms.\n");
});

test("--dry-run shows the patch it would save and writes nothing", async () => {
  const { paths, home } = sandbox();
  const manifest = parseManifest({ version: 2, sources: { vend: { type: "github", repo: "v/skills" } } }, "m");
  replaceLine(2, "line 2, mine")(path.join(paths.skillsDir, "vend-alpha"));
  const before = treeHash(home);
  const out = await edit(paths, manifest, readLock(paths.lockFile), "vend/alpha", "from-disk", { dryRun: true, note: "x", askNote: async () => "" });
  assert.match(out.join("\n"), /^would save .*alpha\.patch:\ndiff --git a\/SKILL\.md b\/SKILL\.md[\s\S]*\+line 2, mine/);
  assert.equal(treeHash(home), before);
});

test("a merge with conflict markers left in MERGED is not finished", async () => {
  const { paths, write, release, run } = sandbox();
  await run("edit", replaceLine(2, "line 2, mine"));
  write(lines(20, { 2: "line 2, upstream" }));
  release();
  await assert.rejects(run("edit"), /Resolve the conflict markers in SKILL\.md first/);
  assert.ok(fs.existsSync(path.join(paths.sklDir, "merge", "vend", "alpha", "MERGED")));
});

test("skillReports lists each skill's patch, in-place edits and merge folder, read from disk", async () => {
  const { paths, write, release, run } = sandbox();
  const { skillReports } = await import("../src/status.ts");
  const manifest = parseManifest({ version: 2, sources: { vend: { type: "github", repo: "v/skills" } } }, "m");
  const report = () => skillReports(paths, manifest, readLock(paths.lockFile));
  const dir = path.join(paths.skillsDir, "vend-alpha");
  assert.deepEqual(report(), [{ id: "vend/alpha", name: "vend-alpha", dir, edited: false }]);
  await run("edit", replaceLine(2, "line 2, mine"));
  fs.appendFileSync(path.join(dir, "SKILL.md"), "x\n");
  const patch = path.join(paths.patchesDir, "vend", "alpha.patch");
  const note = path.join(paths.patchesDir, "vend", "alpha.note.md");
  assert.deepEqual(report(), [{ id: "vend/alpha", name: "vend-alpha", dir, patch, note, edited: true }]);
  fs.writeFileSync(path.join(dir, "SKILL.md"), fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").replace(/x\n$/, ""));
  write(lines(20, { 2: "line 2, upstream" }));
  release();
  const merge = path.join(paths.sklDir, "merge", "vend", "alpha");
  assert.deepEqual(report()[0].conflict, { dir: merge, merged: path.join(merge, "MERGED") });
  // A new machine: the skill waits on its merge and is not installed yet.
  fs.rmSync(paths.lockFile);
  fs.rmSync(paths.skillsDir, { recursive: true });
  assert.deepEqual(report(), [{ id: "vend/alpha", name: "vend-alpha", patch, note, edited: false, conflict: { dir: merge, merged: path.join(merge, "MERGED") } }]);
});
