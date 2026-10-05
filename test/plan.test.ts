import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { apply, removeManaged } from "../src/apply.ts";
import { type PlanInput, plan } from "../src/plan.ts";
import { type ManagedSet, type Registry, defaultPaths } from "../src/registry.ts";
import { type LockEntry, readState } from "../src/state.ts";
import { treeHash } from "../src/treehash.ts";

function sandbox(set: Partial<ManagedSet> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-plan-"));
  const paths = defaultPaths(home);
  const vendor = path.join(home, "vendor");
  const registry: Registry = {
    version: 1,
    sets: { emil: { type: "npm", package: "x@1.0.0", path: "skills", ...set } as ManagedSet },
  };
  const lock: Record<string, LockEntry> = {};
  const pluginSkills = new Map<string, string>();
  const skill = (folder: string, body = "", name = folder) => {
    fs.mkdirSync(path.join(vendor, folder), { recursive: true });
    fs.writeFileSync(path.join(vendor, folder, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
  };
  const run = (opts: Partial<PlanInput> = {}) =>
    plan({
      paths,
      setId: "emil",
      set: registry.sets.emil as ManagedSet,
      state: readState(paths.stateDir),
      lock,
      pluginSkills,
      vendorDir: vendor,
      staging: path.join(paths.stateDir, "staging", "emil"),
      links: paths.links,
      fromInteractiveRun: false,
      today: "2026-10-05",
      ...opts,
    });
  const commit = (p: ReturnType<typeof run>) =>
    apply(paths, p, readState(paths.stateDir), registry, () => {});
  const read = (...p: string[]) => fs.readFileSync(path.join(...p), "utf8");
  return { home, paths, vendor, registry, lock, pluginSkills, skill, run, commit, read };
}

test("first install: copies, links into Claude, records vendor hashes", () => {
  const t = sandbox();
  t.skill("animate");
  t.skill("gesture-ui");
  const p = t.run();
  assert.deepEqual(p.skills.map((s) => [s.name, s.upstream, s.write]), [
    ["animate", "new", true],
    ["gesture-ui", "new", true],
  ]);
  t.commit(p);
  const dest = path.join(t.paths.skillsDir, "animate");
  assert.equal(fs.readlinkSync(path.join(t.paths.links[0], "animate")), dest);
  const st = readState(t.paths.stateDir).sets.emil.skills.animate;
  assert.equal(st.hash, treeHash(path.join(t.vendor, "animate")));
  assert.equal(st.installed, treeHash(dest));
  // Nothing of skillport's lives inside skillsDir.
  assert.deepEqual(fs.readdirSync(t.paths.skillsDir).sort(), ["animate", "gesture-ui"]);
});

test("update writes only what changed upstream and trashes the old copy", () => {
  const t = sandbox();
  t.skill("animate");
  t.skill("gesture-ui");
  t.commit(t.run());
  assert.equal(t.run().skills.filter((s) => s.write).length, 0);

  t.skill("animate", "new advice");
  const p = t.run();
  assert.deepEqual(p.skills.map((s) => [s.name, s.upstream, s.write]), [
    ["animate", "changed", true],
    ["gesture-ui", "unchanged", false],
  ]);
  const trash = t.commit(p);
  assert.match(t.read(t.paths.skillsDir, "animate", "SKILL.md"), /new advice/);
  assert.ok(fs.existsSync(path.join(trash, "animate", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(trash, "gesture-ui")));
});

test("a file the vendor deleted does not linger after update", () => {
  const t = sandbox();
  t.skill("animate");
  fs.writeFileSync(path.join(t.vendor, "animate", "RECIPES.md"), "old");
  t.commit(t.run());
  fs.rmSync(path.join(t.vendor, "animate", "RECIPES.md"));
  t.commit(t.run());
  assert.ok(!fs.existsSync(path.join(t.paths.skillsDir, "animate", "RECIPES.md")));
});

test("skills dropped upstream are trashed and unlinked", () => {
  const t = sandbox();
  t.skill("animate");
  t.skill("gesture-ui");
  t.commit(t.run());
  fs.rmSync(path.join(t.vendor, "gesture-ui"), { recursive: true });
  const p = t.run();
  assert.deepEqual(p.removed, ["gesture-ui"]);
  t.commit(p);
  assert.ok(!fs.existsSync(path.join(t.paths.skillsDir, "gesture-ui")));
  assert.ok(!fs.lstatSync(path.join(t.paths.links[0], "gesture-ui"), { throwIfNoEntry: false }));
});

test("skills allowlist and exclude filter; unselected ones are reported", () => {
  const t = sandbox({ skills: ["animate", "gesture-ui"], exclude: ["gesture-ui"] });
  t.skill("animate");
  t.skill("gesture-ui");
  t.skill("css-animations");
  const p = t.run();
  assert.deepEqual(p.skills.map((s) => s.name), ["animate"]);
  assert.deepEqual(p.unselected, ["css-animations"]);
});

test("collisions: npx skills, another set, unmanaged folder, foreign link; plugins only warn", () => {
  const t = sandbox();
  for (const n of ["tdd", "taken", "loose", "linked", "grilling"]) t.skill(n);
  t.lock.tdd = { source: "mattpocock/skills", skillPath: "", skillFolderHash: "", updatedAt: "" };
  fs.mkdirSync(t.paths.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(t.paths.stateDir, "state.json"),
    JSON.stringify({ version: 1, sets: { other: { syncedAt: "", skills: { taken: { hash: "", installed: "", updatedAt: "" } } } } }),
  );
  fs.mkdirSync(path.join(t.paths.skillsDir, "loose"), { recursive: true });
  fs.mkdirSync(t.paths.links[0], { recursive: true });
  fs.mkdirSync(path.join(t.paths.links[0], "linked"));
  t.pluginSkills.set("grilling", "mattpocock-skills");

  const p = t.run();
  const held = Object.fromEntries(p.collisions.map((c) => [c.name, c.holder]));
  assert.deepEqual(Object.keys(held).sort(), ["linked", "loose", "taken", "tdd"]);
  assert.match(held.linked, /\.claude\/skills\/linked, which skillport did not create/);
  assert.match(held.loose, /unmanaged folder/);
  assert.equal(held.taken, 'set "other"');
  assert.equal(held.tdd, "npx skills (mattpocock/skills)");
  assert.equal(p.warnings.length, 1);
  assert.throws(() => t.commit(p), /unresolved/);
});

test("rename: folder, frontmatter and references move; upstream stays unchanged", () => {
  const t = sandbox();
  t.skill("prototype", "Picker in PICKER.md.");
  t.skill("animate", "Use the `prototype` skill. Not `initial`/`animate`.");
  t.commit(t.run());

  (t.registry.sets.emil as ManagedSet).rename = {
    prototype: { to: "anim-prototype", reason: "collides with matt", at: "2026-10-05" },
  };
  const p = t.run();
  assert.deepEqual(p.removed, ["prototype"]);
  assert.deepEqual(p.skills.map((s) => [s.original, s.name, s.upstream, s.write]), [
    ["animate", "animate", "unchanged", true],
    ["prototype", "anim-prototype", "unchanged", true],
  ]);
  t.commit(p);
  assert.match(t.read(t.paths.skillsDir, "anim-prototype", "SKILL.md"), /^---\nname: anim-prototype\n/);
  assert.match(t.read(t.paths.skillsDir, "animate", "SKILL.md"), /`anim-prototype` skill/);
  const st = readState(t.paths.stateDir).sets.emil.skills["anim-prototype"];
  assert.equal(st.original, "prototype");
  assert.equal(st.hash, treeHash(path.join(t.vendor, "prototype")));
  // Re-running with the rule in place is a no-op.
  assert.equal(t.run().skills.filter((s) => s.write).length, 0);
});

test("interactive capture records the selection and in-installer renames", () => {
  const t = sandbox();
  // The installer renamed the folder but left `name:` alone.
  t.skill("anim-prototype", "", "prototype");
  t.skill("animate");
  const p = t.run({ fromInteractiveRun: true });
  assert.deepEqual(p.captured?.skills, ["animate", "prototype"]);
  assert.deepEqual(p.captured?.rename.prototype, { to: "anim-prototype", reason: "renamed in installer", at: "2026-10-05" });
  let saved: Registry | undefined;
  apply(t.paths, p, readState(t.paths.stateDir), t.registry, (r) => (saved = r));
  assert.match(t.read(t.paths.skillsDir, "anim-prototype", "SKILL.md"), /^---\nname: anim-prototype\n/);
  const set = saved!.sets.emil as ManagedSet;
  assert.deepEqual(set.skills, ["animate", "prototype"]);
  assert.equal(set.rename?.prototype.to, "anim-prototype");
});

test("local edits are detected and replaced only with the old copy in trash", () => {
  const t = sandbox();
  t.skill("animate");
  t.commit(t.run());
  fs.appendFileSync(path.join(t.paths.skillsDir, "animate", "SKILL.md"), "my note\n");
  const p = t.run();
  assert.deepEqual(p.skills.map((s) => [s.upstream, s.write, s.localEdits]), [["unchanged", true, true]]);
  const trash = t.commit(p);
  assert.match(t.read(trash, "animate", "SKILL.md"), /my note/);
});

test("removeManaged trashes the set and removes only its own links", () => {
  const t = sandbox();
  t.skill("animate");
  t.commit(t.run());
  assert.deepEqual(removeManaged(t.paths, "emil", readState(t.paths.stateDir)), ["animate"]);
  assert.ok(!fs.existsSync(path.join(t.paths.skillsDir, "animate")));
  assert.ok(!fs.lstatSync(path.join(t.paths.links[0], "animate"), { throwIfNoEntry: false }));
  assert.equal(readState(t.paths.stateDir).sets.emil, undefined);
});

test("a name that is not a single safe segment is rejected before anything is written", () => {
  const t = sandbox();
  t.skill("evil", "", "../../../pwned");
  const p = t.run();
  assert.match(p.errors.join("\n"), /"\.\.\/\.\.\/\.\.\/pwned" is not a valid skill name/);
  assert.deepEqual(p.skills, []);
  assert.ok(!fs.existsSync(path.join(t.paths.stateDir, "pwned")));
  assert.ok(!fs.existsSync(path.join(t.home, ".agents", "pwned")));
});

test("a rename rule cannot point outside skillsDir either", () => {
  const t = sandbox({ rename: { animate: { to: "../x", reason: "hand-edited", at: "" } } });
  t.skill("animate");
  assert.match(t.run().errors.join("\n"), /"\.\.\/x" is not a valid skill name/);
});

test("skills containing symlinks are refused, so no outside file is copied in", () => {
  const t = sandbox();
  const secret = path.join(t.home, "secret");
  fs.writeFileSync(secret, "TOP-SECRET");
  t.skill("leak");
  fs.symlinkSync(secret, path.join(t.vendor, "leak", "notes.md"));
  t.skill("animate");
  const p = t.run();
  assert.match(p.errors.join("\n"), /leak contains entries skillport does not install.*notes\.md/);
  assert.deepEqual(p.skills.map((s) => s.name), ["animate"]);
  const staged = fs.readdirSync(path.join(t.paths.stateDir, "staging", "emil", "out"));
  assert.deepEqual(staged, ["animate"]);
});

test("a FIFO in vendor content is refused without being read", () => {
  const t = sandbox();
  t.skill("animate");
  t.skill("blocker");
  execFileSync("mkfifo", [path.join(t.vendor, "blocker", "notes.md")]);
  const p = t.run();
  assert.match(p.errors.join("\n"), /blocker contains entries skillport does not install.*notes\.md/);
  assert.deepEqual(p.skills.map((s) => s.name), ["animate"]);
});

test("a symlinked skill folder and a FIFO SKILL.md are refused", () => {
  const t = sandbox();
  const elsewhere = path.join(t.home, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "SKILL.md"), "---\nname: elsewhere\n---\n");
  fs.mkdirSync(t.vendor, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(t.vendor, "linked"));
  fs.mkdirSync(path.join(t.vendor, "pipe"));
  execFileSync("mkfifo", [path.join(t.vendor, "pipe", "SKILL.md")]);
  const p = t.run();
  assert.equal(p.skills.length, 0);
  assert.match(p.errors.join("\n"), /linked contains entries/);
  assert.match(p.errors.join("\n"), /pipe contains entries.*SKILL\.md/);
});

test("apply re-checks: a folder or foreign link that appeared after planning stops it untouched", () => {
  const t = sandbox();
  t.skill("animate");
  const p = t.run();
  fs.mkdirSync(path.join(t.paths.skillsDir, "animate"), { recursive: true });
  fs.writeFileSync(path.join(t.paths.skillsDir, "animate", "mine.md"), "mine");
  assert.throws(() => t.commit(p), /changed since the plan was made/);
  assert.equal(t.read(t.paths.skillsDir, "animate", "mine.md"), "mine");
  assert.equal(readState(t.paths.stateDir).sets.emil, undefined);

  const t2 = sandbox();
  t2.skill("animate");
  const p2 = t2.run();
  fs.mkdirSync(t2.paths.links[0], { recursive: true });
  fs.symlinkSync("/somewhere/else", path.join(t2.paths.links[0], "animate"));
  assert.throws(() => t2.commit(p2), /not skillport's link/);
  assert.equal(fs.readlinkSync(path.join(t2.paths.links[0], "animate")), "/somewhere/else");
  assert.ok(!fs.existsSync(path.join(t2.paths.skillsDir, "animate")));
});

test("invalid state keys are reported and never used as paths", () => {
  const t = sandbox();
  t.skill("animate");
  fs.mkdirSync(t.paths.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(t.paths.stateDir, "state.json"),
    JSON.stringify({ version: 1, sets: { emil: { syncedAt: "", skills: { "../../x": { hash: "", installed: "", updatedAt: "" } } } } }),
  );
  const p = t.run();
  assert.deepEqual(p.removed, []);
  assert.match(p.errors.join("\n"), /invalid skill name "\.\.\/\.\.\/x"/);
  assert.deepEqual(removeManaged(t.paths, "emil", readState(t.paths.stateDir)), []);
});

test("links follow the set: none means no symlink, and dropping a target removes our link", () => {
  const t = sandbox();
  t.skill("animate");
  t.commit(t.run());
  const at = path.join(t.paths.links[0], "animate");
  assert.ok(fs.lstatSync(at).isSymbolicLink());
  assert.equal(t.run().relink, false);
  const p = t.run({ links: [] });
  assert.equal(p.relink, true);
  t.commit(p);
  assert.ok(!fs.lstatSync(at, { throwIfNoEntry: false }));
  assert.equal(t.run({ links: [] }).relink, false);
  assert.ok(fs.existsSync(path.join(t.paths.skillsDir, "animate", "SKILL.md")));
});

test("adopt takes over identical copies and cleans up the scattered ones", () => {
  const t = sandbox();
  t.skill("animate", "same body");
  // What a vendor installer left behind: one copy in ~/.agents/skills, one in
  // ~/.codex/skills, a real folder (not a link) in ~/.claude/skills.
  const copy = (dir: string) => fs.cpSync(path.join(t.vendor, "animate"), path.join(dir, "animate"), { recursive: true });
  const codex = path.join(t.home, ".codex", "skills");
  copy(t.paths.skillsDir);
  copy(codex);
  copy(t.paths.links[0]);

  const plain = t.run();
  assert.equal(plain.collisions.length, 1);
  const p = t.run({ adopt: true });
  assert.deepEqual(p.collisions, []);
  assert.deepEqual(p.adopted, ["animate"]);
  assert.deepEqual(p.strays.sort(), [path.join(t.paths.links[0], "animate"), path.join(codex, "animate")].sort());
  t.commit(p);
  assert.ok(fs.lstatSync(path.join(t.paths.links[0], "animate")).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(codex, "animate")));
  assert.ok(readState(t.paths.stateDir).sets.emil.skills.animate);
});

test("adopt still refuses a copy whose content differs", () => {
  const t = sandbox();
  t.skill("animate");
  fs.mkdirSync(path.join(t.paths.skillsDir, "animate"), { recursive: true });
  fs.writeFileSync(path.join(t.paths.skillsDir, "animate", "SKILL.md"), "someone else's");
  const p = t.run({ adopt: true });
  assert.match(p.collisions[0].holder, /different content/);
  assert.deepEqual(p.adopted, []);
});

test("state records the pinned package a set was synced with", () => {
  const t = sandbox();
  t.skill("animate");
  t.commit(t.run());
  assert.equal(readState(t.paths.stateDir).sets.emil.source, "x@1.0.0");
});

test("N3: a dangling symlink of yours in ~/.agents/skills is a collision, not free space", () => {
  const t = sandbox();
  t.skill("animate");
  fs.mkdirSync(t.paths.skillsDir, { recursive: true });
  fs.symlinkSync(path.join(t.home, "dev", "moved-away"), path.join(t.paths.skillsDir, "animate"));
  const p = t.run();
  assert.equal(p.collisions[0]?.kind, "unowned");
  assert.throws(() => t.commit(p));
  assert.ok(fs.lstatSync(path.join(t.paths.skillsDir, "animate")).isSymbolicLink());
});

test("taking over one folder in the prompt adopts only that skill", () => {
  const t = sandbox();
  t.skill("animate");
  t.skill("gesture-ui");
  const codex = path.join(t.home, ".codex", "skills");
  for (const n of ["animate", "gesture-ui"]) {
    fs.cpSync(path.join(t.vendor, n), path.join(t.paths.skillsDir, n), { recursive: true });
    fs.cpSync(path.join(t.vendor, n), path.join(codex, n), { recursive: true });
  }
  const p = t.run({ adopt: ["animate"] });
  assert.deepEqual(p.adopted, ["animate"]);
  assert.deepEqual(p.strays, [path.join(codex, "animate")]);
  assert.deepEqual(p.collisions.map((c) => c.name), ["gesture-ui"]);
});
