import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireLock } from "../src/apply.ts";
import { readManifest } from "../src/manifest.ts";
import { defaultPaths } from "../src/paths.ts";

const BIN = path.join(import.meta.dirname, "..", "bin", "skillport");

// A fake installer: writes one skill into $HOME/.claude/skills, like the
// vendor installers do, so the CLI runs end to end without the network.
const INSTALL = `const fs=require("fs"),p=require("os").homedir()+"/.claude/skills/animate";fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+"/SKILL.md","---\\nname: animate\\ndescription: d\\n---\\n")`;

function sandbox(extra: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-cli-"));
  const paths = defaultPaths(home);
  const manifest = { version: 2, sources: { emil: { type: "installer", command: ["node", "-e", INSTALL, "--"], unattended: [], prefix: false, ...extra } } };
  fs.mkdirSync(path.dirname(paths.manifest), { recursive: true });
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest));
  const skl = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(BIN, args, { env: { ...process.env, SKILLPORT_HOME: home, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { home, paths, skl };
}

test("the run lock refuses a second live run and takes over a stale one", () => {
  const paths = defaultPaths(fs.mkdtempSync(path.join(os.tmpdir(), "skl-lock-")));
  const release = acquireLock(paths.sklDir);
  assert.throws(() => acquireLock(paths.sklDir), /in progress/);
  release();
  fs.mkdirSync(path.join(paths.sklDir, "lock.d"));
  fs.writeFileSync(path.join(paths.sklDir, "lock.d", "pid"), "999999");
  acquireLock(paths.sklDir)();
  assert.equal((fs.statSync(paths.sklDir).mode & 0o777).toString(8), "700");
});

test("update installs with -y and leaves no fetch folder or lock behind", () => {
  const t = sandbox();
  const r = t.skl(["update", "emil", "-y"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(t.paths.skillsDir, "animate", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(t.paths.sklDir, "fetch")));
  assert.ok(!fs.existsSync(path.join(t.paths.sklDir, "lock.d")));
});

test("an installer without `unattended` is skipped by update, not run with guessed flags", () => {
  const t = sandbox({ unattended: undefined });
  const r = t.skl(["update", "emil", "-y"]);
  assert.match(r.stdout, /emil {2}skipped: its installer only runs with you at the terminal; add -i/);
  assert.ok(!fs.existsSync(path.join(t.paths.skillsDir, "animate")));
});

test("the installer gets exactly command + unattended, nothing added", () => {
  const argsFile = path.join(os.tmpdir(), `skl-args-${process.pid}`);
  const script = `require("fs").writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(1)));${INSTALL}`;
  const t = sandbox({ command: ["node", "-e", script, "--", "--scope", "user"], unattended: ["--non-interactive"] });
  assert.equal(t.skl(["update", "emil", "-y"]).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), ["--scope", "user", "--non-interactive"]);
});

test("installers get a minimal environment: no inherited secrets", () => {
  const envFile = path.join(os.tmpdir(), `skl-env-${process.pid}`);
  const script = `require("fs").writeFileSync(${JSON.stringify(envFile)},JSON.stringify(Object.keys(process.env)));${INSTALL}`;
  const t = sandbox({ command: ["node", "-e", script, "--"] });
  const r = t.skl(["update", "emil", "-y"], { SOME_API_KEY: "leak-me" });
  assert.equal(r.status, 0, r.stderr);
  const keys: string[] = JSON.parse(fs.readFileSync(envFile, "utf8"));
  assert.ok(!keys.includes("SOME_API_KEY"));
  assert.ok(keys.includes("PATH") && keys.includes("HOME"));
});

test("without -y and a terminal, remove refuses and changes nothing", () => {
  const t = sandbox();
  t.skl(["update", "emil", "-y"]);
  const r = t.skl(["remove", "emil"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /-y/);
  assert.ok(fs.existsSync(path.join(t.paths.skillsDir, "animate")));
  assert.deepEqual(Object.keys(readManifest(t.paths.manifest).sources), ["emil"]);
});

test("doctor --fix shows a plan, honours --dry-run and needs -y without a terminal", () => {
  const t = sandbox();
  t.skl(["update", "emil", "-y"]);
  const codex = path.join(t.home, ".codex", "skills");
  fs.cpSync(path.join(t.paths.skillsDir, "animate"), path.join(codex, "animate"), { recursive: true });
  const dry = t.skl(["doctor", "--fix", "--dry-run"]);
  assert.match(dry.stdout, /Plan: fix the 1 problem/);
  assert.ok(fs.existsSync(path.join(codex, "animate")));
  assert.match(t.skl(["doctor", "--fix"]).stderr, /pass -y/);
  assert.ok(fs.existsSync(path.join(codex, "animate")));
  assert.equal(t.skl(["doctor", "--fix", "-y"]).status, 0);
  assert.ok(!fs.existsSync(path.join(codex, "animate")));
});

test("a v1 setup without a manifest points at skl migrate", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-cli-"));
  fs.mkdirSync(path.join(home, ".config", "skillport"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "skillport", "registry.json"), JSON.stringify({ version: 1, sets: {} }));
  const r = spawnSync(BIN, ["status"], { env: { ...process.env, SKILLPORT_HOME: home }, encoding: "utf8" });
  assert.match(r.stdout, /Found a skillport v1 setup in ~\/\.config\/skillport\/registry\.json\. See what moving it over would do: skl migrate --dry-run/);
});
