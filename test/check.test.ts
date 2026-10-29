import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type Net, type TreeEntry, check } from "../src/check.ts";
import { treeHashOfListing } from "../src/treehash.ts";
import type { Lock } from "../src/lock.ts";
import { type SkillId, type SourceId, parseManifest } from "../src/manifest.ts";
import { defaultPaths, withLinkTargets } from "../src/paths.ts";
import { formatStatus } from "../src/status.ts";
import { readLock } from "../src/lock.ts";
import { sync } from "../src/sync.ts";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const NOW = "2026-10-29T10:00:00.000Z";

/** A recursive listing with one SKILL.md per skill; `blob` stands for its content. */
const tree = (skills: Record<string, string>, extra: TreeEntry[] = []): TreeEntry[] => [
  ...Object.entries(skills).flatMap(([name, blob]) => [
    { path: `skills/${name}`, mode: "040000", type: "tree", sha: "e".repeat(40) },
    { path: `skills/${name}/SKILL.md`, mode: "100644", type: "blob", sha: blob.repeat(40) },
  ]),
  ...extra,
];
const hashOf = (blob: string) => treeHashOfListing(tree({ x: blob }), "skills/x", () => false) as string;

function fakeNet(head: string | null, skills: Record<string, string> | null = null, latest: string | null = null, extra: TreeEntry[] = []) {
  const calls = { head: 0, tree: 0, npm: 0 };
  const net: Net = {
    headCommit: () => (calls.head++, head),
    tree: () => (calls.tree++, skills ? tree(skills, extra) : null),
    latestVersion: () => (calls.npm++, latest),
    hasToken: () => true,
  };
  return { net, calls };
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-check-"));
  const paths = withLinkTargets(defaultPaths(home), {});
  const manifest = parseManifest(
    {
      version: 2,
      sources: {
        matt: { type: "github", repo: "mattpocock/skills" },
        motion: { type: "npm", package: "motion-ai@14.1.0", path: "content/skills" },
        vend: { type: "installer", command: ["npx", "-y", "@v/install@0.1.4", "--global"], unattended: [] },
      },
    },
    "manifest.json",
  );
  const lock: Lock = {
    version: 2,
    sources: { ["matt" as SourceId]: { resolved: OLD, syncedAt: NOW, seen: ["tdd", "grilling", "wizard"] } },
    skills: {
      ["matt/tdd" as SkillId]: { name: "matt-tdd", base: hashOf("1"), output: "x", updatedAt: NOW },
      ["matt/grilling" as SkillId]: { name: "matt-grilling", base: hashOf("2"), output: "x", updatedAt: NOW },
    },
  };
  return { paths, manifest, lock };
}

test("an unchanged commit costs no tree call", () => {
  const { paths, manifest, lock } = setup();
  const { net, calls } = fakeNet(OLD);
  const s = check(paths, manifest, lock, null, ["matt"], net, NOW);
  assert.equal(s.sources["matt" as SourceId].state, "up-to-date");
  assert.deepEqual(calls, { head: 1, tree: 0, npm: 0 });
});

test("a moved commit costs one tree call and names changed, new and removed skills", () => {
  const { paths, manifest, lock } = setup();
  const { net, calls } = fakeNet(NEW, { tdd: "9", wizard: "3", deploy: "4" });
  const s = check(paths, manifest, lock, null, ["matt"], net, NOW).sources["matt" as SourceId];
  assert.deepEqual(s, {
    checkedAt: NOW,
    state: "updates",
    from: "aaaaaaa",
    to: "bbbbbbb",
    changed: ["tdd"],
    added: ["deploy"],
    removed: ["grilling"],
    link: "https://github.com/mattpocock/skills/compare/aaaaaaa...bbbbbbb",
  });
  assert.deepEqual(calls, { head: 1, tree: 1, npm: 0 });
});

test("a moved commit with the same skill folders is up to date", () => {
  const { paths, manifest, lock } = setup();
  const { net } = fakeNet(NEW, { tdd: "1", grilling: "2", wizard: "3" });
  assert.equal(check(paths, manifest, lock, null, ["matt"], net, NOW).sources["matt" as SourceId].state, "up-to-date");
});

test("files npx skills leaves out when it copies do not read as a change", () => {
  const { paths, manifest, lock } = setup();
  const skipped: TreeEntry[] = [
    { path: "skills/tdd/metadata.json", mode: "100644", type: "blob", sha: "7".repeat(40) },
    { path: "skills/tdd/__pycache__", mode: "040000", type: "tree", sha: "8".repeat(40) },
    { path: "skills/tdd/__pycache__/x.pyc", mode: "100644", type: "blob", sha: "8".repeat(40) },
  ];
  const { net } = fakeNet(NEW, { tdd: "1", grilling: "2", wizard: "3" }, null, skipped);
  assert.equal(check(paths, manifest, lock, null, ["matt"], net, NOW).sources["matt" as SourceId].state, "up-to-date");
});

test("a skill whose folder is named differently is found through the recorded path", () => {
  const { paths, manifest, lock } = setup();
  const matt = lock.sources["matt" as SourceId];
  matt.seen = ["matt-tdd", "grilling", "wizard"];
  matt.paths = { "matt-tdd": "skills/tdd", grilling: "skills/grilling", wizard: "skills/wizard" };
  lock.skills = { ["matt/matt-tdd" as SkillId]: { name: "matt-tdd", base: hashOf("1"), output: "x", updatedAt: NOW } };
  const { net } = fakeNet(NEW, { tdd: "1", grilling: "2", wizard: "3" });
  assert.equal(check(paths, manifest, lock, null, ["matt"], net, NOW).sources["matt" as SourceId].state, "up-to-date");
});

test("an unreachable GitHub is unknown, not an error", () => {
  const { paths, manifest, lock } = setup();
  const { net } = fakeNet(null);
  assert.deepEqual(check(paths, manifest, lock, null, ["matt"], net, NOW).sources["matt" as SourceId], {
    checkedAt: NOW,
    state: "unknown",
    reason: "GitHub unreachable",
  });
});

test("npm and pinned installers compare versions", () => {
  const { paths, manifest, lock } = setup();
  const s = check(paths, manifest, lock, null, ["motion", "vend"], fakeNet(null, null, "0.1.5").net, NOW);
  assert.deepEqual(s.sources["vend" as SourceId], { checkedAt: NOW, state: "pinned-behind", current: "0.1.4", latest: "0.1.5" });
  assert.equal(s.sources["motion" as SourceId].state, "pinned-behind");
});

test("checking one source keeps the others' last result, and status prints a row per source", () => {
  const { paths, manifest, lock } = setup();
  const first = check(paths, manifest, lock, null, [], fakeNet(OLD, null, "14.1.0").net, "2026-10-29T08:00:00.000Z");
  const second = check(paths, manifest, lock, first, ["matt"], fakeNet(null).net, NOW);
  assert.equal(second.sources["motion" as SourceId].checkedAt, "2026-10-29T08:00:00.000Z");
  assert.equal(
    formatStatus(manifest, lock, second, Date.parse("2026-10-29T10:00:30.000Z")),
    [
      "SOURCE  TYPE       STATE                           CHECKED",
      "matt    github     can't tell: GitHub unreachable  just now",
      "motion  npm        up to date (pinned 14.1.0)      2h ago",
      "vend    installer  installer 14.1.0 available      2h ago",
    ].join("\n"),
  );
  assert.throws(() => check(paths, manifest, lock, null, ["nope"], fakeNet(OLD).net, NOW), /Unknown source nope/);
});

test("a local source reports a changed skill and an edited one", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-check-local-"));
  const src = path.join(home, "src");
  fs.cpSync(path.join(import.meta.dirname, "fixtures", "v2", "local"), src, { recursive: true });
  const paths = withLinkTargets(defaultPaths(home), {});
  const manifest = parseManifest({ version: 2, sources: { fx: { type: "local", path: src } } }, "manifest.json");
  sync(paths, manifest, readLock(paths.lockFile));
  fs.appendFileSync(path.join(src, "alpha", "SKILL.md"), "\nUpstream.\n");
  fs.appendFileSync(path.join(paths.skillsDir, "fx-beta", "SKILL.md"), "\nMine.\n");
  const s = check(paths, manifest, readLock(paths.lockFile), null, [], fakeNet(null).net, NOW);
  assert.equal(s.sources["fx" as SourceId].state, "updates");
  assert.deepEqual((s.sources["fx" as SourceId] as { changed: string[] }).changed, ["alpha"]);
  assert.deepEqual(s.skills, { ["fx/beta" as SkillId]: { edited: true } });
});

test("a local skill held back for its name stays blocked after another sync", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-check-held-"));
  const src = path.join(home, "src");
  fs.cpSync(path.join(import.meta.dirname, "fixtures", "v2", "local"), src, { recursive: true });
  const paths = withLinkTargets(defaultPaths(home), {});
  const manifest = parseManifest({ version: 2, sources: { fx: { type: "local", path: src } } }, "manifest.json");
  sync(paths, manifest, readLock(paths.lockFile));
  fs.mkdirSync(path.join(src, "gamma"));
  fs.writeFileSync(path.join(src, "gamma", "SKILL.md"), "---\nname: gamma\ndescription: g\n---\n");
  fs.mkdirSync(path.join(paths.skillsDir, "fx-gamma"));
  sync(paths, manifest, readLock(paths.lockFile));
  assert.equal(check(paths, manifest, readLock(paths.lockFile), null, [], fakeNet(null).net, NOW).sources["fx" as SourceId].state, "blocked");
});
