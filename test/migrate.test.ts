import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type Fetched, skillsIn } from "../src/adapters/index.ts";
import { readLock } from "../src/lock.ts";
import { type SourceId, readManifest } from "../src/manifest.ts";
import { describePlan, migrate, planMigration, v1Files } from "../src/migrate.ts";
import { defaultPaths } from "../src/registry.ts";
import { treeHash } from "../src/treehash.ts";

const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const skill = (dir: string, name: string, body = "") => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}`);
};

/** A v1 setup: an npm set, a namespaced installer set, and npx skills sets installed, unsupported and never installed. */
function v1() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-mig-"));
  const paths = defaultPaths(home);
  const files = v1Files(paths);
  const vendor = (id: string) => path.join(home, "vendor", id);
  skill(vendor("motion"), "motion");
  for (const n of ["animate", "polish"]) skill(vendor("emil"), n);
  for (const n of ["tdd", "grill"]) skill(vendor("matt"), n);
  writeJson(files.registry, {
    version: 1,
    sets: {
      motion: { type: "npm", package: "motion-ai@14.2.0", path: "content/skills" },
      emil: { type: "installer", command: ["npx", "-y", "@emil/install@1.0.0", "--token={secret}"], secret: "keychain", unattended: ["-y"], namespace: "emil", rename: { polish: { to: "emil-shine" } } },
      matt: { type: "skills-cli", source: "mattpocock/skills" },
      tree: { type: "skills-cli", source: "https://example.com/skills.git" },
      never: { type: "skills-cli", source: "a/b" },
    },
  });
  // v1's folders and links as it left them.
  const installed: Record<string, Record<string, { original?: string; installed: string }>> = {
    motion: { motion: { installed: "" } },
    emil: { "emil-animate": { original: "animate", installed: "" }, "emil-shine": { original: "polish", installed: "" } },
  };
  for (const [id, skills] of Object.entries(installed)) {
    for (const [name, s] of Object.entries(skills)) {
      fs.cpSync(path.join(vendor(id), s.original ?? name), path.join(paths.skillsDir, name), { recursive: true });
      s.installed = treeHash(path.join(paths.skillsDir, name));
    }
  }
  for (const n of ["tdd", "grill", "other"]) skill(paths.skillsDir, n);
  const claude = path.join(home, ".claude", "skills");
  fs.mkdirSync(claude, { recursive: true });
  for (const n of ["motion", "emil-animate", "emil-shine", "tdd"]) fs.symlinkSync(path.join(paths.skillsDir, n), path.join(claude, n));
  writeJson(files.state, {
    version: 1,
    sets: Object.fromEntries(Object.entries(installed).map(([id, skills]) => [id, { skills }])),
    cli: { matt: { skills: ["tdd", "grill"] }, tree: { skills: ["other"] } },
  });
  const entry = (source: string, n: string) => ({ source, skillPath: `skills/${n}/SKILL.md`, skillFolderHash: "h", updatedAt: "t" });
  writeJson(paths.skillLock, { version: 3, skills: { tdd: entry("mattpocock/skills", "tdd"), grill: entry("mattpocock/skills", "grill"), other: entry("x", "other") } });
  const fetched = new Map<SourceId, Fetched>(
    (["motion", "emil", "matt"] as SourceId[]).map((id) => [id, { resolved: "1".repeat(40), skills: skillsIn(vendor(id)) }]),
  );
  return { home, paths, files, claude, fetched };
}

const noRemoval = async (q: string) => !q.startsWith("Remove the originals");

test("migrate plans v1 sets as v2 sources that keep every installed name", () => {
  const { paths } = v1();
  const plan = planMigration(paths);
  assert.deepEqual(plan.manifest.sources, {
    motion: { type: "npm", package: "motion-ai@14.2.0", path: "content/skills", prefix: false, pick: ["motion"] },
    emil: {
      type: "installer",
      command: ["npx", "-y", "@emil/install@1.0.0", "--token={secret}"],
      unattended: ["-y"],
      secret: "keychain",
      prefix: "emil",
      rename: { polish: "emil-shine" },
      pick: ["animate", "polish"],
    },
    matt: { type: "github", repo: "mattpocock/skills", pick: ["tdd", "grill"] },
  });
  assert.deepEqual(
    [...plan.replaced, ...plan.adopted].map((m) => `${m.from} -> ${m.to}`),
    ["motion -> motion", "emil-animate -> emil-animate", "emil-shine -> emil-shine", "tdd -> matt-tdd", "grill -> matt-grill"],
  );
  assert.deepEqual(plan.skipped.map((s) => s.id), ["tree", "never"]);
  assert.match(describePlan(plan).join("\n"), /emil {2}\(installer\)\n {2}2 skills keep their names\nmatt[^\n]*\n {2}tdd -> matt-tdd[\s\S]*Then npx skills removes the originals: tdd, grill/);
});

test("migrate --dry-run prints the plan and writes nothing", async () => {
  const { paths, home } = v1();
  const before = treeHash(home);
  const lines: string[] = [];
  const fetch = () => assert.fail("a dry run fetches nothing");
  assert.equal(await migrate(paths, { dryRun: true, yes: false, discardEdits: false, confirm: null, print: (l) => lines.push(l), fetch }), 0);
  assert.match(lines.join("\n"), /dry run: nothing changed\./);
  assert.equal(treeHash(home), before);
});

test("migrate installs the v2 copies, keeps v1's links working and sets v1's files aside", async () => {
  const { paths, files, claude, fetched } = v1();
  const lines: string[] = [];
  await migrate(paths, { dryRun: false, yes: false, discardEdits: false, confirm: noRemoval, print: (l) => lines.push(l), fetch: () => ({ fetched, failed: 0 }) });
  assert.deepEqual(Object.keys(readManifest(paths.manifest).sources), ["motion", "emil", "matt"]);
  assert.deepEqual(Object.values(readLock(paths.lockFile).skills).map((s) => s.name).sort(), ["emil-animate", "emil-shine", "matt-grill", "matt-tdd", "motion"]);
  for (const n of ["motion", "emil-animate", "emil-shine", "matt-tdd"]) assert.ok(fs.existsSync(path.join(claude, n)), n);
  assert.ok(!fs.existsSync(files.registry) && fs.existsSync(`${files.registry}.v1`));
  assert.ok(!fs.existsSync(files.state) && fs.existsSync(`${files.state}.v1`));
  // The npx skills originals stay until you say so.
  assert.ok(fs.existsSync(path.join(paths.skillsDir, "tdd")));
  assert.match(lines.join("\n"), /Kept the npx skills originals\. To remove them: npx skills remove tdd grill -g -y/);
  await assert.rejects(migrate(paths, { dryRun: true, yes: true, discardEdits: false, confirm: null, print: () => {}, fetch: () => ({ fetched, failed: 0 }) }), /already exists/);
});

test("migrate changes nothing when a skill was edited in place, a source fails, or a skill is gone upstream", async () => {
  const { paths, home, fetched } = v1();
  const opts = { dryRun: false, yes: true, discardEdits: false, confirm: null, print: () => {} };
  fs.appendFileSync(path.join(paths.skillsDir, "emil-shine", "SKILL.md"), "Mine.\n");
  const before = treeHash(home);
  await assert.rejects(migrate(paths, { ...opts, fetch: () => ({ fetched, failed: 0 }) }), /you edited emil-shine in place/);
  await assert.rejects(migrate(paths, { ...opts, discardEdits: true, fetch: () => ({ fetched, failed: 1 }) }), /could not be fetched/);
  const partial = new Map(fetched);
  partial.delete("matt" as SourceId);
  await assert.rejects(migrate(paths, { ...opts, discardEdits: true, fetch: () => ({ fetched: partial, failed: 0 }) }), /matt could not be fetched/);
  const shrunk = new Map(fetched);
  shrunk.set("emil" as SourceId, { ...fetched.get("emil" as SourceId)!, skills: fetched.get("emil" as SourceId)!.skills.filter((s) => s.original !== "polish") });
  await assert.rejects(migrate(paths, { ...opts, discardEdits: true, fetch: () => ({ fetched: shrunk, failed: 0 }) }), /no longer ships emil\/polish/);
  assert.equal(treeHash(home), before);
});

test("migrate puts v1 back when the install fails", async () => {
  const { paths, files, fetched } = v1();
  // A folder npx skills does not track takes a v2 name, so sync refuses.
  skill(paths.skillsDir, "matt-tdd");
  const before = treeHash(paths.skillsDir);
  await assert.rejects(
    migrate(paths, { dryRun: false, yes: true, discardEdits: false, confirm: null, print: () => {}, fetch: () => ({ fetched, failed: 0 }) }),
    /matt-tdd/,
  );
  assert.ok(fs.existsSync(files.state) && !fs.existsSync(paths.manifest));
  assert.equal(treeHash(paths.skillsDir), before);
});
