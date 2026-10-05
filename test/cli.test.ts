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
    sets: { emil: { type: "installer", command: ["node", "-e", script, "--"], unattended: [], ...extra } },
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
  assert.ok(!fs.existsSync(path.join(t.paths.stateDir, "lock.d")));
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
  fs.mkdirSync(path.join(paths.stateDir, "lock.d"));
  fs.writeFileSync(path.join(paths.stateDir, "lock.d", "pid"), "999999");
  acquireLock(paths)();
  assert.equal((fs.statSync(paths.stateDir).mode & 0o777).toString(8), "700");
});

test("an installer without `unattended` is skipped by update, not run with guessed flags", () => {
  const t = sandbox({ unattended: undefined });
  const r = t.skl("update", "emil", "-y");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /only runs interactively; skipped/);
  assert.ok(!fs.existsSync(path.join(t.paths.skillsDir, "animate")));
});

test("the installer gets exactly command + unattended, nothing added", () => {
  const argsFile = path.join(os.tmpdir(), `skillport-args-${process.pid}`);
  const script = `require("fs").writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(1)));const fs=require("fs"),p=require("os").homedir()+"/.claude/skills/animate";fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+"/SKILL.md","---\\nname: animate\\n---\\n")`;
  const t = sandbox({ command: ["node", "-e", script, "--", "--scope", "user"], unattended: ["--non-interactive"] });
  assert.equal(t.skl("update", "emil", "-y").status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), ["--scope", "user", "--non-interactive"]);
});

test("installers get a minimal environment: no inherited secrets", () => {
  const envFile = path.join(os.tmpdir(), `skillport-env-${process.pid}`);
  const script = `require("fs").writeFileSync(${JSON.stringify(envFile)},JSON.stringify(Object.keys(process.env)));const fs=require("fs"),p=require("os").homedir()+"/.claude/skills/animate";fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+"/SKILL.md","---\\nname: animate\\n---\\n")`;
  const t = sandbox({ command: ["node", "-e", script, "--"] });
  const r = spawnSync(BIN, ["update", "emil", "-y"], {
    env: { ...process.env, SKILLPORT_HOME: t.home, SOME_API_KEY: "leak-me" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(r.status, 0, r.stderr);
  const keys: string[] = JSON.parse(fs.readFileSync(envFile, "utf8"));
  assert.ok(!keys.includes("SOME_API_KEY"));
  assert.ok(keys.includes("PATH") && keys.includes("HOME"));
});

test("a set needing a token that is missing fails early with the fix, before running anything", () => {
  const t = sandbox({ secret: "keychain", command: ["node", "-e", "process.exit(9)", "--", "--token={secret}"] });
  // Use a set id with no Keychain entry.
  const file = t.paths.registry;
  const reg = JSON.parse(fs.readFileSync(file, "utf8"));
  reg.sets["no-such-token-set"] = reg.sets.emil;
  delete reg.sets.emil;
  fs.writeFileSync(file, JSON.stringify(reg));
  const r = t.skl("update", "no-such-token-set", "-y");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No Keychain secret for "no-such-token-set"\. Run: skl secret/);
  assert.doesNotMatch(r.stderr, /exited 9/);
});
