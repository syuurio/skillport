import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillsIn } from "../src/adapters/index.ts";
import { diff } from "../src/diff.ts";
import { readLock } from "../src/lock.ts";
import { type SourceId, parseManifest, readManifest, writeManifest } from "../src/manifest.ts";
import { defaultPaths, withLinkTargets } from "../src/registry.ts";
import { removeSource } from "../src/remove.ts";
import { sync } from "../src/sync.ts";
import { treeHash } from "../src/treehash.ts";

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-dr-"));
  const vendor = path.join(home, "vendor");
  const skill = (name: string, body = "") => {
    fs.mkdirSync(path.join(vendor, name), { recursive: true });
    fs.writeFileSync(path.join(vendor, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nUse the \`beta\` skill.\n${body}`);
  };
  skill("alpha");
  skill("beta");
  const paths = withLinkTargets(defaultPaths(home), {});
  const manifest = parseManifest({ version: 2, sources: { vend: { type: "github", repo: "v/skills" } } }, paths.manifest);
  writeManifest(paths.manifest, manifest);
  let version = 1;
  const fetched = () => new Map([["vend" as SourceId, { resolved: String(version).repeat(40), skills: skillsIn(vendor) }]]);
  sync(paths, manifest, readLock(paths.lockFile), { fetched: fetched() });
  const bump = () => (version++, fetched());
  return { home, paths, manifest, skill, bump };
}

test("skl diff shows the next update as a diff of the installed folder, and writes no skill", () => {
  const { paths, manifest, skill, bump } = sandbox();
  skill("alpha", "Changed upstream.\n");
  const before = treeHash(paths.skillsDir);
  const out = diff(paths, manifest, readLock(paths.lockFile), "vend/alpha", bump()).join("\n");
  assert.match(out, /^vend\/alpha -> vend-alpha\n {2}vend-alpha\/SKILL\.md:\d+: `beta` -> `vend-beta`\ndiff --git a\/SKILL\.md b\/SKILL\.md/);
  assert.match(out, /\n\+Changed upstream\.$/);
  assert.doesNotMatch(out, /vend-beta\/SKILL\.md/);
  assert.equal(treeHash(paths.skillsDir), before);
  assert.deepEqual(diff(paths, manifest, readLock(paths.lockFile), "vend/beta", bump()), ["vend/beta: no changes"]);
  assert.throws(() => diff(paths, manifest, readLock(paths.lockFile), "nope", bump()), /Unknown source nope/);
});

test("skl remove trashes the source's skills and links and drops it from the manifest", async () => {
  const { paths, manifest } = sandbox();
  fs.mkdirSync(path.join(paths.patchesDir, "vend"), { recursive: true });
  const out = await removeSource(paths, manifest, readLock(paths.lockFile), "vend", { yes: true, discardEdits: false, confirm: null });
  assert.match(out.join("\n"), /removed vend-alpha \(vend\/alpha\)[\s\S]*Removed sources\.vend[\s\S]*Kept your patches/);
  assert.deepEqual(fs.readdirSync(paths.skillsDir), []);
  assert.ok(!fs.existsSync(path.join(paths.home, ".claude", "skills", "vend-alpha")));
  assert.deepEqual(readManifest(paths.manifest).sources, {});
  assert.deepEqual(readLock(paths.lockFile), { version: 2, sources: {}, skills: {} });
});

test("skl remove refuses a source with a skill you edited in place, and asks without -y", async () => {
  const { paths, manifest } = sandbox();
  fs.appendFileSync(path.join(paths.skillsDir, "vend-beta", "SKILL.md"), "Mine.\n");
  const opts = { yes: true, discardEdits: false, confirm: null };
  await assert.rejects(removeSource(paths, manifest, readLock(paths.lockFile), "vend", opts), /you edited vend-beta in place/);
  await assert.rejects(removeSource(paths, manifest, readLock(paths.lockFile), "vend", { ...opts, yes: false, discardEdits: true }), /needs -y/);
  const no = await removeSource(paths, manifest, readLock(paths.lockFile), "vend", { ...opts, yes: false, discardEdits: true, confirm: async () => false });
  assert.deepEqual(no, ["Nothing was changed."]);
  assert.ok(fs.existsSync(path.join(paths.skillsDir, "vend-beta")));
  await removeSource(paths, manifest, readLock(paths.lockFile), "vend", { ...opts, discardEdits: true });
  assert.deepEqual(fs.readdirSync(paths.skillsDir), []);
});
