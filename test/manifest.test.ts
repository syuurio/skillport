import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readLock, writeLock } from "../src/lock.ts";
import { installedName, parseManifest, readManifest, type SkillName, type Source, type SourceId } from "../src/manifest.ts";

const valid = {
  version: 2,
  targets: ["claude-code"],
  linkTargets: { "claude-work": { label: "Claude Code (work)", dir: "~/.claude-work/skills" } },
  sources: {
    matt: { type: "github", repo: "mattpocock/skills", pick: ["tdd"] },
    aiforui: {
      type: "installer",
      command: ["npx", "-y", "@aiforui/install@0.1.4", "--token={secret}", "--global"],
      unattended: ["-y"],
      secret: "keychain",
      links: ["claude-code", "claude-work"],
    },
    anidev: { type: "github", repo: "https://github.com/animationsdev/skills", rename: { prototype: "anidev-proto" } },
    motion: { type: "npm", package: "motion-ai@14.1.0", path: "content/skills", prefix: false },
    mine: { type: "local", path: "~/dev/my-skills" },
  },
};

const withSources = (sources: Record<string, unknown>) => ({ ...valid, sources: { ...valid.sources, ...sources } });
const problemsOf = (raw: unknown) => {
  try {
    parseManifest(raw, "manifest.json");
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

test("a valid manifest parses", () => {
  assert.equal(parseManifest(valid, "manifest.json").sources["matt" as SourceId].type, "github");
});

test("a missing manifest is empty", () => {
  assert.deepEqual(readManifest(path.join(os.tmpdir(), "skl-no-such", "manifest.json")), { version: 2, sources: {} });
});

test("two sources may not share a prefix", () => {
  const msg = problemsOf(withSources({ anidev: { type: "github", repo: "a/b", prefix: "aiforui" } }));
  assert.match(msg, /sources\.anidev\.prefix "aiforui" is already used by sources\.aiforui/);
});

test("prefix false does not claim a prefix", () => {
  assert.equal(problemsOf(withSources({ other: { type: "local", path: "/x", prefix: false } })), "");
});

test("two renames may not target one name", () => {
  const msg = problemsOf(withSources({ mine: { type: "local", path: "/x", rename: { p: "anidev-proto" } } }));
  assert.match(msg, /"anidev-proto" is the rename target of both sources\.anidev and sources\.mine/);
});

test("names follow the Agent Skills spec", () => {
  const long = "a".repeat(65);
  assert.match(problemsOf(withSources({ [long]: { type: "local", path: "/x" } })), /id must be lowercase/);
  assert.match(problemsOf(withSources({ "Anim_Dev": { type: "local", path: "/x" } })), /sources\.Anim_Dev: id must be lowercase/);
  for (const bad of ["my--x", "my:x", long]) {
    const msg = problemsOf(withSources({ mine: { type: "local", path: "/x", rename: { x: bad } } }));
    assert.match(msg, /rename\.x .* is not a valid skill name/, bad);
  }
  assert.match(problemsOf(withSources({ mine: { type: "local", path: "/x", prefix: "a:b" } })), /prefix must be false or/);
});

test("a token in the command is rejected", () => {
  const msg = problemsOf(withSources({ aiforui: { type: "installer", command: ["npx", "@aiforui/install", "--token=ghp_abcdef1234567890"] } }));
  assert.match(msg, /sources\.aiforui: command contains a literal token/);
});

test("type fields and link targets are checked", () => {
  const msg = problemsOf(
    withSources({
      a: { type: "npm", package: "motion-ai", path: "../x" },
      b: { type: "local", path: "relative" },
      c: { type: "svn" },
      d: { type: "github", repo: "not a repo" },
      e: { type: "local", path: "/x", links: ["cursor"] },
    }),
  );
  assert.match(msg, /sources\.a: package must be .* pinned/);
  assert.match(msg, /sources\.a: path must be a folder inside the package/);
  assert.match(msg, /sources\.b: path must be an absolute folder/);
  assert.match(msg, /sources\.c: type must be/);
  assert.match(msg, /sources\.d: repo must be one word/);
  assert.match(msg, /sources\.e: links: unknown link target "cursor"/);
});

test("the wrong version is rejected", () => {
  assert.match(problemsOf({ version: 1, sets: {} }), /unsupported manifest version 1/);
});

const name = (source: Partial<Source>, original: string, id = "anidev") =>
  installedName(id as SourceId, original as SkillName, { type: "local", path: "/x", ...source } as Source);

test("installed names: default prefix, custom prefix, prefix false, rename", () => {
  assert.equal(name({}, "gesture"), "anidev-gesture");
  assert.equal(name({ prefix: "ani" }, "gesture"), "ani-gesture");
  assert.equal(name({ prefix: false }, "gesture"), "gesture");
  assert.equal(name({ prefix: "ani", rename: { prototype: "proto" } }, "prototype"), "proto");
  assert.equal(name({}, "emil-color", "emil"), "emil-color");
  assert.equal(name({}, "emil", "emil"), "emil");
});

test("the lock round-trips through an atomic write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skl-lock-"));
  const file = path.join(dir, ".skl", "lock.json");
  assert.deepEqual(readLock(file), { version: 2, sources: {}, skills: {} });
  const lock = {
    version: 2 as const,
    sources: { matt: { resolved: "59db609", syncedAt: "2026-10-29T08:00:00Z", seen: ["tdd"] } },
    skills: { "matt/tdd": { name: "matt-tdd", base: "667dbdd", output: "1b9e04c", updatedAt: "2026-10-29T08:00:00Z" } },
  };
  writeLock(file, lock);
  assert.deepEqual(readLock(file), lock);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["lock.json"]);
  fs.rmSync(dir, { recursive: true });
});

test("a lock with a name that is not a skill name is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skl-lock-"));
  const file = path.join(dir, "lock.json");
  const skills = { "fx/a": { name: "../../etc", base: "0".repeat(40), output: "0".repeat(40), updatedAt: "" } };
  fs.writeFileSync(file, JSON.stringify({ version: 2, sources: {}, skills }));
  assert.throws(() => readLock(file), /invalid installed names for fx\/a/);
  fs.rmSync(dir, { recursive: true });
});
