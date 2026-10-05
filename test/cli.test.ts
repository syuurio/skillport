import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireLock } from "../src/apply.ts";
import { defaultPaths, readRegistry } from "../src/registry.ts";

const BIN = path.join(import.meta.dirname, "..", "bin", "skillport");

// A fake installer: writes one skill into $HOME/.claude/skills, like the
// vendor installers do, so the CLI runs end to end without the network.
function sandbox(extra: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-cli-"));
  const script = `const fs=require("fs"),p=require("os").homedir()+"/.claude/skills/animate";fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+"/SKILL.md","---\\nname: animate\\ndescription: d\\n---\\n")`;
  const registry = {
    version: 1,
    sets: { emil: { type: "installer", command: ["node", "-e", script, "--"], ...extra } },
  };
  fs.mkdirSync(path.join(home, ".config", "skillport"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "skillport", "registry.json"), JSON.stringify(registry));
  const skl = (...args: string[]) =>
    spawnSync(BIN, args, { env: { ...process.env, SKILLPORT_HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { home, paths: defaultPaths(home), skl };
}

test("without a terminal, update refuses to apply unless -y", () => {
  const t = sandbox();
  const r = t.skl("update", "emil");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pass -y/);
  assert.ok(!fs.existsSync(path.join(t.paths.skillsDir, "animate")));
  assert.equal(t.skl("update", "emil", "-y").status, 0);
  assert.ok(fs.existsSync(path.join(t.paths.skillsDir, "animate", "SKILL.md")));
});

test("remove --dry-run removes nothing; staging is gone after every run", () => {
  const t = sandbox();
  t.skl("update", "emil", "-y");
  const r = t.skl("remove", "emil", "--dry-run");
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(t.paths.skillsDir, "animate")));
  assert.ok(readRegistry(t.paths.registry).sets.emil);
  assert.ok(!fs.existsSync(path.join(t.paths.stateDir, "staging", "emil")));
  assert.ok(!fs.existsSync(path.join(t.paths.stateDir, "lock")));
});

test("a failing installer leaves no staging behind", () => {
  const t = sandbox({ command: ["node", "-e", "process.exit(3)", "--"] });
  const r = t.skl("update", "emil", "-y");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exited 3/);
  assert.ok(!fs.existsSync(path.join(t.paths.stateDir, "staging", "emil")));
});

test("set ids must be safe folder names", () => {
  const t = sandbox();
  const file = t.paths.registry;
  const reg = JSON.parse(fs.readFileSync(file, "utf8"));
  reg.sets[".."] = reg.sets.emil;
  fs.writeFileSync(file, JSON.stringify(reg));
  const r = t.skl("status");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /set id "\.\." must use/);
});

test("the run lock refuses a second live run and takes over a stale one", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-lock-"));
  const paths = defaultPaths(home);
  const release = acquireLock(paths);
  assert.throws(() => acquireLock(paths), /in progress/);
  release();
  fs.writeFileSync(path.join(paths.stateDir, "lock"), "999999");
  acquireLock(paths)();
});
