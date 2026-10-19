import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultPaths, readRegistry } from "../src/registry.ts";
import { agentArgs, lockedFor, parseList, planCli } from "../src/skillscli.ts";
import { normalizeSource } from "../src/validate.ts";
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
  const state: State = {
    version: 1,
    sets: { emil: { syncedAt: "", skills: { prototype: { hash: "", installed: "", updatedAt: "" } } } },
    cli: { matt: { syncedAt: "", skills: ["tdd", "old"] } },
  };
  const p = planCli({
    paths,
    setId: "matt",
    set: { type: "skills-cli", source: "mattpocock/skills", exclude: ["grilling"] },
    want: ["tdd", "prototype", "loose", "other", "grilling"],
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

test("S2: a skills-cli set never removes what it did not install; one set per source", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-own-"));
  const paths = defaultPaths(home);
  const entry = (source: string): LockEntry => ({ source, skillPath: "", skillFolderHash: "", updatedAt: "" });
  const lock = { tdd: entry("mattpocock/skills"), grill: entry("mattpocock/skills"), mine: entry("mattpocock/skills") };
  const plan = (owned: string[]) =>
    planCli({
      paths,
      setId: "m",
      set: { type: "skills-cli", source: "mattpocock/skills" },
      want: ["tdd"],
      available: ["tdd", "grill", "mine"],
      lock,
      state: { version: 1, sets: {}, cli: { m: { syncedAt: "", skills: owned } } },
    });
  // First run: nothing recorded, so everything already installed from the
  // source is someone else's, even tdd, which this set wants.
  assert.deepEqual(plan([]).remove, []);
  assert.deepEqual(plan([]).update, []);
  assert.deepEqual(plan([]).others, ["grill", "mine", "tdd"]);
  // The set installed grill before and no longer wants it: that one goes.
  assert.deepEqual(plan(["tdd", "grill"]).remove, ["grill"]);

  fs.mkdirSync(path.dirname(paths.registry), { recursive: true });
  fs.writeFileSync(paths.registry, JSON.stringify({ version: 1, sets: { a: { type: "skills-cli", source: "mattpocock/skills" }, b: { type: "skills-cli", source: "https://github.com/mattpocock/skills" } } }));
  assert.throws(() => readRegistry(paths.registry), /already used by set "a"/);
});

test("a skills-cli set's links follow its setting for skills already installed", async () => {
  const { cliLinkChanges, applyCliLinks } = await import("../src/skillscli.ts");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-clilinks-"));
  const paths = defaultPaths(home);
  fs.mkdirSync(path.join(paths.skillsDir, "tdd"), { recursive: true });
  const claude = paths.links[0];
  // links includes Claude Code, no link yet: add it.
  let c = cliLinkChanges(paths, ["tdd"], [claude]);
  assert.deepEqual(c, { add: [path.join(claude, "tdd")], remove: [] });
  applyCliLinks(paths, c);
  assert.equal(fs.readlinkSync(path.join(claude, "tdd")), path.join(paths.skillsDir, "tdd"));
  // Claude Code dropped from links: our link goes; a folder of yours would stay.
  c = cliLinkChanges(paths, ["tdd"], []);
  assert.deepEqual(c.remove, [path.join(claude, "tdd")]);
  applyCliLinks(paths, c);
  assert.ok(!fs.lstatSync(path.join(claude, "tdd"), { throwIfNoEntry: false }));
  fs.mkdirSync(path.join(claude, "tdd"));
  assert.deepEqual(cliLinkChanges(paths, ["tdd"], []).remove, []);
});

test("a skills-cli set gets links in registry link targets, which npx skills does not know", async () => {
  const { cliLinkChanges } = await import("../src/skillscli.ts");
  const { withLinkTargets } = await import("../src/registry.ts");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-clitarget-"));
  const paths = withLinkTargets(defaultPaths(home), { version: 1, linkTargets: { work: { dir: "~/.claude-work/skills" } }, sets: {} });
  const work = path.join(home, ".claude-work", "skills");
  assert.equal(paths.linkTargets.work, work);
  assert.ok(paths.agentDirs.includes(work));
  fs.mkdirSync(path.join(paths.skillsDir, "tdd"), { recursive: true });
  // npx skills already made Claude Code's link; only the work one is missing.
  fs.mkdirSync(paths.links[0], { recursive: true });
  fs.symlinkSync(path.join(paths.skillsDir, "tdd"), path.join(paths.links[0], "tdd"));
  assert.deepEqual(cliLinkChanges(paths, ["tdd"], [paths.links[0], work]), { add: [path.join(work, "tdd")], remove: [] });
});
