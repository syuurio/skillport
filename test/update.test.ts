import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillsIn } from "../src/adapters/index.ts";
import { readLock } from "../src/lock.ts";
import { type SourceId, parseManifest } from "../src/manifest.ts";
import { defaultPaths, withLinkTargets } from "../src/paths.ts";
import { sync } from "../src/sync.ts";
import { treeHash } from "../src/treehash.ts";
import { edit } from "../src/edit.ts";
import { type UpdateFlags, type UpdateIO, update } from "../src/update.ts";

const flags = (f: Partial<UpdateFlags> = {}): UpdateFlags => ({ yes: true, dryRun: false, pick: false, interactive: false, discardEdits: false, ...f });

/** A github source whose "repo" is a folder here, fetched without the network. */
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-update-"));
  const vendor = path.join(home, "vendor");
  const skill = (name: string, body = "") => {
    fs.mkdirSync(path.join(vendor, name), { recursive: true });
    fs.writeFileSync(path.join(vendor, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
  };
  skill("alpha");
  skill("beta");
  const paths = withLinkTargets(defaultPaths(home), {});
  const manifest = parseManifest({ version: 2, sources: { vend: { type: "github", repo: "v/skills" } } }, "manifest.json");
  let version = 1;
  const fetch = () => ({ resolved: String(version).repeat(40).slice(0, 40), skills: skillsIn(vendor) });
  sync(paths, manifest, readLock(paths.lockFile), { fetched: new Map([["vend" as SourceId, fetch()]]) });
  const out: string[] = [];
  const io = (answers: { pick?: string[]; apply?: boolean } = {}): UpdateIO => ({
    canAsk: answers.pick !== undefined || answers.apply !== undefined,
    confirm: async () => answers.apply ?? false,
    chooseMany: async () => answers.pick ?? [],
    print: (line) => out.push(line),
  });
  const run = async (f: Partial<UpdateFlags> = {}, answers = {}) => {
    out.length = 0;
    version++;
    await update(paths, manifest, readLock(paths.lockFile), null, [], flags(f), io(answers), fetch);
    return out.join("\n");
  };
  const trashed = () => {
    const t = path.join(paths.sklDir, "trash");
    return fs.existsSync(t) ? fs.readdirSync(t).flatMap((d) => fs.readdirSync(path.join(t, d))) : [];
  };
  const customize = (change: (text: string) => string) =>
    edit(paths, manifest, readLock(paths.lockFile), "vend/alpha", "edit", {
      editor: (dir) => {
        const file = path.join(dir, "SKILL.md");
        fs.writeFileSync(file, change(fs.readFileSync(file, "utf8")));
        return true;
      },
      askNote: async () => "",
    });
  return { home, paths, vendor, skill, run, trashed, customize };
}

const ls = (dir: string) => fs.readdirSync(dir).sort();

test("an upstream change replaces only that folder; a second run is up to date", async () => {
  const { paths, skill, run, trashed } = sandbox();
  const beta = fs.statSync(path.join(paths.skillsDir, "vend-beta")).ino;
  skill("alpha", "Changed upstream.");
  assert.equal(await run(), "vend  1111111 → 2222222\n  replace   vend-alpha\n\nvend/alpha -> vend-alpha");
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "vend-alpha", "SKILL.md"), "utf8"), /Changed upstream/);
  assert.equal(fs.statSync(path.join(paths.skillsDir, "vend-beta")).ino, beta);
  assert.deepEqual(trashed(), ["vend-alpha"]);
  assert.equal(await run(), "up to date");
});

test("a skill removed upstream is removed", async () => {
  const { paths, vendor, run } = sandbox();
  fs.rmSync(path.join(vendor, "beta"), { recursive: true });
  assert.match(await run(), /  remove    vend-beta/);
  assert.deepEqual(ls(paths.skillsDir), ["vend-alpha"]);
});

test("a skill you edited in place is held back and kept", async () => {
  const { paths, skill, run } = sandbox();
  fs.appendFileSync(path.join(paths.skillsDir, "vend-beta", "SKILL.md"), "Mine.\n");
  skill("alpha", "Changed upstream.");
  skill("beta", "Changed upstream.");
  const out = await run();
  assert.match(out, /  replace   vend-alpha\n\nHeld back \(not applied\):\n  edited    vend-beta .*\n {12}keep your edits: {3}skl edit vend\/beta --from-disk\n {12}discard them: {6}skl update vend --discard-edits/);
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "vend-beta", "SKILL.md"), "utf8"), /Mine\./);
  assert.match(await run({ discardEdits: true }), /replace   vend-beta/);
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "vend-beta", "SKILL.md"), "utf8"), /Changed upstream/);
});

test("with -y a new vendor skill is listed, not installed, and listed again next time", async () => {
  const { paths, skill, run } = sandbox();
  skill("gamma");
  assert.equal(await run(), "vend  1111111 → 2222222\n  new       gamma");
  assert.deepEqual(ls(paths.skillsDir), ["vend-alpha", "vend-beta"]);
  assert.match(await run(), /new       gamma/);
});

test("on a terminal a new skill is picked inline; the unpicked one is not asked about again", async () => {
  const { paths, skill, run } = sandbox();
  skill("gamma");
  skill("delta");
  const out = await run({ yes: false }, { pick: ["gamma"], apply: true });
  assert.match(out, /new       delta, gamma/);
  assert.match(out, /vend\/gamma -> vend-gamma/);
  assert.deepEqual(ls(paths.skillsDir), ["vend-alpha", "vend-beta", "vend-gamma"]);
  assert.equal(await run({ yes: false }, { pick: [], apply: true }), "up to date");
});

test("a dry run writes nothing", async () => {
  const { home, paths, skill, run } = sandbox();
  skill("alpha", "Changed upstream.");
  fs.rmSync(path.join(paths.sklDir, "store"), { recursive: true });
  const before = treeHash(home);
  assert.match(await run({ dryRun: true }), /replace   vend-alpha\n\ndry run: nothing changed\./);
  fs.rmSync(path.join(paths.sklDir, "store"), { recursive: true, force: true });
  assert.equal(treeHash(home), before);
});

test("the plan shows a reapplied patch, and a conflicting one under Held back", async () => {
  const { skill, run, customize } = sandbox();
  await customize((t) => `${t}Mine.\n`);
  skill("alpha", "Upstream above.\n\n\n\n");
  assert.match(await run(), /  replace   vend-alpha {9}patch reapplied/);
  await customize((t) => t.replace("Upstream above.", "Mine above."));
  skill("alpha", "Upstream changed.\n\n\n\n");
  assert.match(await run(), /Held back \(not applied\):\n  conflict  vend-alpha {9}you and upstream changed the same lines: SKILL\.md\n {12}resolve in .*merge\/vend\/alpha\n {12}then: {14}skl edit vend\/alpha/);
});
