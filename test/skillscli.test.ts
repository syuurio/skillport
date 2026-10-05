import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultPaths } from "../src/registry.ts";
import { agentArgs, lockedFor, normalizeSource, parseList, planCli } from "../src/skillscli.ts";
import type { LockEntry, State } from "../src/state.ts";

// Shape of `npx skills@1.7.0 add mattpocock/skills --list`, colours included.
const LISTING = [
  "\x1b[36m◇\x1b[39m  Found 3 skills",
  "│",
  "◇  Available Skills",
  "Mattpocock Skills",
  "│",
  "│    ask-matt",
  "│",
  "│      Ask which skill or flow fits your situation.",
  "│",
  "│    \x1b[1mtdd\x1b[22m",
  "│",
  "│      Test-driven development.",
  "│      word",
  "│    code-review",
  "└",
].join("\n");

test("parseList reads skill names, not descriptions or headings", () => {
  assert.deepEqual(parseList(LISTING), ["ask-matt", "tdd", "code-review"]);
});

test("normalizeSource folds GitHub spellings to owner/repo", () => {
  for (const s of ["mattpocock/skills", "https://github.com/mattpocock/skills", "https://github.com/mattpocock/skills.git", "git@github.com:mattpocock/skills.git"]) {
    assert.equal(normalizeSource(s), "mattpocock/skills", s);
  }
  assert.equal(normalizeSource("notion"), "notion");
});

test("agentArgs always puts the real folder in ~/.agents (codex) and adds Claude only when linked", () => {
  assert.deepEqual(agentArgs(["/h/.claude/skills"], "/h/.claude/skills"), ["-a", "codex", "-a", "claude-code"]);
  assert.deepEqual(agentArgs([], "/h/.claude/skills"), ["-a", "codex"]);
});

test("planCli splits add / update / remove / unselected and refuses collisions", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-cli-plan-"));
  const paths = defaultPaths(home);
  fs.mkdirSync(path.join(paths.skillsDir, "loose"), { recursive: true });
  const entry = (source: string): LockEntry => ({ source, skillPath: "", skillFolderHash: "", updatedAt: "" });
  const lock = { tdd: entry("mattpocock/skills"), old: entry("https://github.com/mattpocock/skills.git"), other: entry("someone/else") };
  const state: State = { version: 1, sets: { emil: { syncedAt: "", skills: { prototype: { hash: "", installed: "", updatedAt: "" } } } } };
  const p = planCli({
    paths,
    setId: "matt",
    set: { type: "skills-cli", source: "mattpocock/skills", skills: ["tdd", "prototype", "loose", "other", "grilling"], exclude: ["grilling"] },
    available: ["tdd", "prototype", "loose", "other", "grilling", "wizard"],
    lock,
    state,
  });
  assert.deepEqual(lockedFor(lock, "https://github.com/mattpocock/skills"), ["old", "tdd"]);
  assert.deepEqual(p.update, ["tdd"]);
  assert.deepEqual(p.remove, ["old"]);
  assert.deepEqual(p.add, ["prototype", "loose", "other"]);
  assert.deepEqual(p.unselected, ["wizard"]);
  assert.deepEqual(
    p.collisions.map((c) => [c.name, c.holder.split(" ")[0]]),
    [["prototype", "set"], ["loose", "an"], ["other", "npx"]],
  );
});

test("planCli refuses to let npx skills replace your own symlink in ~/.claude/skills", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-cli-link-"));
  const paths = defaultPaths(home);
  fs.mkdirSync(paths.links[0], { recursive: true });
  fs.mkdirSync(path.join(home, "dev", "bar"), { recursive: true });
  fs.symlinkSync(path.join(home, "dev", "bar"), path.join(paths.links[0], "bar"));
  const p = planCli({
    paths,
    setId: "m",
    set: { type: "skills-cli", source: "a/b" },
    available: ["bar"],
    lock: {},
    state: { version: 1, sets: {} },
  });
  assert.match(p.collisions[0]?.holder ?? "", /which skillport did not create/);
});
