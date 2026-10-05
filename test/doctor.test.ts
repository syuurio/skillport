import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { diagnose } from "../src/doctor.ts";
import { type Registry, defaultPaths } from "../src/registry.ts";
import type { State } from "../src/state.ts";
import { treeHash } from "../src/treehash.ts";

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-doctor-"));
  const paths = defaultPaths(home);
  const skill = (dir: string, name: string, body = "x") => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n${body}\n`);
    return path.join(dir, name);
  };
  const animate = skill(paths.skillsDir, "animate");
  const gesture = skill(paths.skillsDir, "gesture-ui");
  const registry: Registry = {
    version: 1,
    sets: {
      emil: {
        type: "npm",
        package: "x@1.0.0",
        path: "s",
        rename: { prototype: { to: "anim-prototype", reason: "collides with set \"matt\"", at: "2026-10-05" } },
      },
    },
  };
  const state: State = {
    version: 1,
    sets: {
      emil: {
        syncedAt: "",
        skills: {
          animate: { hash: "", installed: treeHash(animate), updatedAt: "" },
          "gesture-ui": { hash: "", installed: "not-what-is-on-disk", updatedAt: "" },
        },
      },
    },
  };
  fs.mkdirSync(paths.links[0], { recursive: true });
  fs.symlinkSync(animate, path.join(paths.links[0], "animate"));
  return { home, paths, registry, state, skill, animate, gesture };
}

test("doctor finds each kind of drift and marks only the safe ones fixable", () => {
  const w = world();
  const codex = path.join(w.home, ".codex", "skills");
  w.skill(codex, "animate"); // identical stray copy
  w.skill(path.join(w.home, ".cursor", "skills"), "animate", "changed"); // different copy
  fs.symlinkSync(path.join(w.paths.skillsDir, "gone"), path.join(w.paths.links[0], "gone")); // broken
  w.skill(w.paths.skillsDir, "orphan"); // unowned

  const f = diagnose(w.paths, w.registry, w.state, {});
  const kinds = (k: string) => f.filter((x) => x.kind === k);
  assert.equal(kinds("stray-copy").length, 2);
  assert.ok(kinds("stray-copy").find((x) => /identical/.test(x.message))?.fix);
  assert.ok(!kinds("stray-copy").find((x) => /different/.test(x.message))?.fix);
  assert.equal(kinds("broken-link").length, 1);
  assert.equal(kinds("missing-link").length, 1); // gesture-ui has no Claude link
  assert.equal(kinds("edited").length, 1); // gesture-ui hash differs
  assert.equal(kinds("unowned").length, 1);
  assert.equal(kinds("stale-rule").length, 1);

  for (const x of f) x.fix?.();
  assert.ok(!fs.existsSync(path.join(codex, "animate")));
  assert.ok(fs.existsSync(path.join(w.home, ".cursor", "skills", "animate")));
  assert.ok(!fs.lstatSync(path.join(w.paths.links[0], "gone"), { throwIfNoEntry: false }));
  assert.ok(fs.lstatSync(path.join(w.paths.links[0], "gesture-ui")).isSymbolicLink());
  assert.ok(fs.readdirSync(path.join(w.paths.stateDir, "trash")).length > 0);
});

test("doctor reports two owners for one name", () => {
  const w = world();
  const lock = { animate: { source: "a/b", skillPath: "", skillFolderHash: "", updatedAt: "" } };
  assert.ok(diagnose(w.paths, w.registry, w.state, lock).some((x) => x.kind === "collision" && /animate/.test(x.message)));
});

test("a copy that only adds per-agent files counts as identical; your own symlinks are not unowned", () => {
  const w = world();
  const codex = w.skill(path.join(w.home, ".codex", "skills"), "animate");
  fs.mkdirSync(path.join(codex, "agents"));
  fs.writeFileSync(path.join(codex, "agents", "openai.yaml"), "interface: {}\n");
  const mine = w.skill(path.join(w.home, "dev"), "note-taking");
  fs.symlinkSync(mine, path.join(w.paths.skillsDir, "note-taking"));
  const f = diagnose(w.paths, w.registry, w.state, {});
  assert.ok(f.find((x) => x.kind === "stray-copy" && x.message.includes(".codex"))?.fix);
  assert.ok(!f.some((x) => x.kind === "unowned"));
});

test("names from state or the lock that are not skill names never become paths", () => {
  const w = world();
  // A folder outside ~/.agents/skills that a crafted name would reach.
  const victim = path.join(w.home, "victim");
  w.skill(w.home, "victim");
  w.state.sets.emil.skills["../../victim"] = { hash: "", installed: treeHash(victim), updatedAt: "" };
  const lock = { "../../../victim": { source: "a/b", skillPath: "", skillFolderHash: "", updatedAt: "" } };
  const f = diagnose(w.paths, w.registry, w.state, lock);
  for (const x of f) x.fix?.();
  assert.ok(fs.existsSync(path.join(victim, "SKILL.md")));
  assert.equal(f.filter((x) => /invalid skill name/.test(x.message)).length, 2);
});

test("--fix never treats a copy with your own additions as identical", () => {
  const w = world();
  const codex = w.skill(path.join(w.home, ".codex", "skills"), "animate");
  fs.writeFileSync(path.join(codex, "MY-NOTES.md"), "mine");
  const f = diagnose(w.paths, w.registry, w.state, {});
  const stray = f.find((x) => x.kind === "stray-copy" && x.message.includes(".codex"));
  assert.ok(stray && !stray.fix);
  assert.match(stray.message, /different content/);
});

test("stale rules: a hand-made rename with no collision left, and a rule for a skill no longer shipped", () => {
  const w = world();
  w.registry.sets.emil = {
    type: "npm",
    package: "x@1.0.0",
    path: "s",
    rename: {
      animate: { to: "emil-animate", reason: "resolved by hand", at: "2026-10-06" },
      gone: { to: "emil-gone", reason: "collides with set \"x\"", at: "2026-10-06" },
      picked: { to: "my-pick", reason: "renamed in installer", at: "2026-10-06" },
    },
  };
  w.state.sets.emil.skills["my-pick"] = { original: "picked", hash: "", installed: "", updatedAt: "" };
  const stale = diagnose(w.paths, w.registry, w.state, {}).filter((x) => x.kind === "stale-rule").map((x) => x.message);
  assert.equal(stale.length, 2);
  assert.ok(stale.some((m) => /animate → emil-animate \(resolved by hand\) is no longer needed/.test(m)));
  assert.ok(stale.some((m) => /gone is no longer shipped/.test(m)));
});

test("a rename made against an unowned folder is not stale while that folder exists", () => {
  const w = world();
  w.skill(w.paths.skillsDir, "loose");
  w.registry.sets.emil = { type: "npm", package: "x@1.0.0", path: "s", rename: { loose: { to: "emil-loose", reason: "collides with an unmanaged folder", at: "" } } };
  w.state.sets.emil.skills["emil-loose"] = { original: "loose", hash: "", installed: "", updatedAt: "" };
  const stale = () => diagnose(w.paths, w.registry, w.state, {}).filter((x) => x.kind === "stale-rule");
  assert.equal(stale().length, 0);
  fs.rmSync(path.join(w.paths.skillsDir, "loose"), { recursive: true });
  assert.equal(stale().length, 1);
});

test("fixing a stray copy in ~/.claude/skills puts our link in its place", () => {
  const w = world();
  const claude = w.paths.links[0];
  fs.unlinkSync(path.join(claude, "animate"));
  fs.cpSync(w.animate, path.join(claude, "animate"), { recursive: true });
  const f = diagnose(w.paths, w.registry, w.state, {}).find((x) => x.kind === "stray-copy" && x.message.includes(".claude"));
  f?.fix?.();
  assert.equal(fs.readlinkSync(path.join(claude, "animate")), w.animate);
});
