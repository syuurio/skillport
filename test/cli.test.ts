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

test("an installer stuck on a question is reported as needing you, not as a failure", () => {
  const t = sandbox({ command: ["node", "-e", "console.log('Install everything? (y/n)');process.exit(1)", "--"] });
  const r = t.skl("update", "emil", "-y");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /waiting for answers.*skl update emil -i/);
});

test("doctor --fix shows a plan, honours --dry-run and needs -y without a terminal", () => {
  const t = sandbox();
  t.skl("update", "emil", "-y");
  const codex = path.join(t.home, ".codex", "skills");
  fs.cpSync(path.join(t.paths.skillsDir, "animate"), path.join(codex, "animate"), { recursive: true });
  const dry = t.skl("doctor", "--fix", "--dry-run");
  assert.match(dry.stdout, /Plan: fix the 1 problem/);
  assert.ok(fs.existsSync(path.join(codex, "animate")));
  const noTty = t.skl("doctor", "--fix");
  assert.match(noTty.stderr, /pass -y/);
  assert.ok(fs.existsSync(path.join(codex, "animate")));
  assert.equal(t.skl("doctor", "--fix", "-y").status, 0);
  assert.ok(!fs.existsSync(path.join(codex, "animate")));
});

test("status counts a skills-cli set's skills whatever spelling its source uses", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-status-"));
  const paths = defaultPaths(home);
  fs.mkdirSync(path.dirname(paths.registry), { recursive: true });
  fs.writeFileSync(paths.registry, JSON.stringify({ version: 1, sets: { m: { type: "skills-cli", source: "https://github.com/mattpocock/skills" } } }));
  fs.mkdirSync(path.dirname(paths.skillLock), { recursive: true });
  fs.writeFileSync(paths.skillLock, JSON.stringify({ version: 3, skills: { tdd: { source: "mattpocock/skills", skillPath: "", skillFolderHash: "", updatedAt: "" } } }));
  const status = () => spawnSync(BIN, ["status"], { env: { ...process.env, SKILLPORT_HOME: home }, encoding: "utf8" }).stdout;
  // Not recorded as the set's: shown as left alone, not counted.
  assert.match(status(), /m\s+skills-cli\s+0 skills/);
  assert.match(status(), /left alone \(installed outside this set\): tdd/);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, "state.json"), JSON.stringify({ version: 1, sets: {}, cli: { m: { syncedAt: "2026-10-06T00:00:00Z", skills: ["tdd"] } } }));
  assert.match(status(), /m\s+skills-cli\s+1 skill\b/);
});

test("check and diff also report an installer stuck on a question as needing you", () => {
  const t = sandbox({ command: ["node", "-e", "console.log('Continue? (y/n)');process.exit(1)", "--"] });
  const check = t.skl("check", "emil");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /waiting for answers/);
  const diff = t.skl("diff", "emil", "animate");
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(diff.stdout, /waiting for answers/);
});

test("M1: when npx skills fails after adding, the added skills are still recorded as the set's", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-m1-"));
  const paths = defaultPaths(home);
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // A stand-in npx: lists a, b; add creates the folder and lock entry; update fails.
  fs.writeFileSync(
    path.join(bin, "npx"),
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2).filter((a) => a !== "-y" && !a.startsWith("skills@"));
const home = process.env.HOME, lockFile = path.join(home, ".agents", ".skill-lock.json");
const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, "utf8")) : { version: 3, skills: {} };
if (args[0] === "add" && args.includes("--list")) { console.log("│    a\\n│    b"); process.exit(0); }
if (args[0] === "add") {
  for (let i = 0; i < args.length; i++) if (args[i] === "-s") {
    const n = args[i + 1];
    fs.mkdirSync(path.join(home, ".agents", "skills", n), { recursive: true });
    fs.writeFileSync(path.join(home, ".agents", "skills", n, "SKILL.md"), "x");
    lock.skills[n] = { source: "acme/skills", skillPath: "", skillFolderHash: "", updatedAt: "" };
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  process.exit(0);
}
if (args[0] === "update") { console.error("network down"); process.exit(1); }
process.exit(0);
`,
  );
  fs.chmodSync(path.join(bin, "npx"), 0o755);
  fs.mkdirSync(path.dirname(paths.registry), { recursive: true });
  fs.writeFileSync(paths.registry, JSON.stringify({ version: 1, sets: { acme: { type: "skills-cli", source: "acme/skills" } } }));
  // a was added and recorded on an earlier run; this run adds b, then update of a fails.
  fs.mkdirSync(path.join(paths.skillsDir, "a"), { recursive: true });
  fs.writeFileSync(paths.skillLock, JSON.stringify({ version: 3, skills: { a: { source: "acme/skills", skillPath: "", skillFolderHash: "", updatedAt: "" } } }));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, "state.json"), JSON.stringify({ version: 1, sets: {}, cli: { acme: { syncedAt: "", skills: ["a"] } } }));
  const r = spawnSync(BIN, ["update", "acme", "-y"], {
    env: { ...process.env, SKILLPORT_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npx skills update failed/);
  const state = JSON.parse(fs.readFileSync(path.join(paths.stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.cli.acme.skills, ["a", "b"]);
});

test("round 6: an add that fails partway still records the names it installed", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-m1-"));
  const paths = defaultPaths(home);
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // A stand-in npx: lists a, b; add creates the folder and lock entry; update fails.
  fs.writeFileSync(
    path.join(bin, "npx"),
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2).filter((a) => a !== "-y" && !a.startsWith("skills@"));
const home = process.env.HOME, lockFile = path.join(home, ".agents", ".skill-lock.json");
const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, "utf8")) : { version: 3, skills: {} };
if (args[0] === "add" && args.includes("--list")) { console.log("│    a\\n│    b\\n│    c"); process.exit(0); }
if (args[0] === "add") {
  let count = 0;
  for (let i = 0; i < args.length; i++) if (args[i] === "-s") {
    if (count++ === 1) { fs.writeFileSync(lockFile, JSON.stringify(lock)); console.error("disk full"); process.exit(1); }
    const n = args[i + 1];
    fs.mkdirSync(path.join(home, ".agents", "skills", n), { recursive: true });
    fs.writeFileSync(path.join(home, ".agents", "skills", n, "SKILL.md"), "x");
    lock.skills[n] = { source: "acme/skills", skillPath: "", skillFolderHash: "", updatedAt: "" };
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  process.exit(0);
}
if (args[0] === "update") { console.error("network down"); process.exit(1); }
process.exit(0);
`,
  );
  fs.chmodSync(path.join(bin, "npx"), 0o755);
  fs.mkdirSync(path.dirname(paths.registry), { recursive: true });
  fs.writeFileSync(paths.registry, JSON.stringify({ version: 1, sets: { acme: { type: "skills-cli", source: "acme/skills" } } }));
  // a was added and recorded on an earlier run; this run adds b, then update of a fails.
  fs.mkdirSync(path.join(paths.skillsDir, "a"), { recursive: true });
  fs.writeFileSync(paths.skillLock, JSON.stringify({ version: 3, skills: { a: { source: "acme/skills", skillPath: "", skillFolderHash: "", updatedAt: "" } } }));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, "state.json"), JSON.stringify({ version: 1, sets: {}, cli: { acme: { syncedAt: "", skills: ["a"] } } }));
  const r = spawnSync(BIN, ["update", "acme", "-y"], {
    env: { ...process.env, SKILLPORT_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npx skills add failed/);
  const state = JSON.parse(fs.readFileSync(path.join(paths.stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.cli.acme.skills, ["a", "b"]); // c never landed
});
