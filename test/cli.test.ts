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
  const release = acquireLock(paths.stateDir);
  assert.throws(() => acquireLock(paths.stateDir), /in progress/);
  release();
  fs.mkdirSync(path.join(paths.stateDir, "lock.d"));
  fs.writeFileSync(path.join(paths.stateDir, "lock.d", "pid"), "999999");
  acquireLock(paths.stateDir)();
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
  // a and b were chosen earlier; b has gone missing, so this run adds it
  // back, then the update of a fails. Both stay recorded, and b is on disk.
  fs.mkdirSync(path.join(paths.skillsDir, "a"), { recursive: true });
  fs.writeFileSync(paths.skillLock, JSON.stringify({ version: 3, skills: { a: { source: "acme/skills", skillPath: "", skillFolderHash: "", updatedAt: "" } } }));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, "state.json"), JSON.stringify({ version: 1, sets: {}, cli: { acme: { syncedAt: "", skills: ["a", "b"] } } }));
  const r = spawnSync(BIN, ["update", "acme", "-y"], {
    env: { ...process.env, SKILLPORT_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npx skills update failed/);
  const state = JSON.parse(fs.readFileSync(path.join(paths.stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.cli.acme.skills, ["a", "b"]);
  assert.ok(fs.existsSync(path.join(paths.skillsDir, "b", "SKILL.md")));
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
  // First install with -y: every skill is wanted; the add fails after a lands.
  const r = spawnSync(BIN, ["add", "acme", "-y"], {
    env: { ...process.env, SKILLPORT_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npx skills add failed/);
  const state = JSON.parse(fs.readFileSync(path.join(paths.stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.cli.acme.skills, ["a"]); // b and c never landed
});

test("replace frees a name by excluding it from the set that holds it", async () => {
  const { freeOtherSide } = await import("../src/collide.ts");
  const t = sandbox();
  assert.equal(t.skl("update", "emil", "-y").status, 0);
  const regFile = path.join(t.home, ".config", "skillport", "registry.json");
  const ctx = {
    paths: t.paths,
    registry: readRegistry(regFile),
    saveRegistry: (r: unknown) => fs.writeFileSync(regFile, JSON.stringify(r)),
  };
  await freeOtherSide(ctx, "emil", "animate", "incoming", "replace", async () => t.skl("update", "emil", "-y").status ?? 1);
  assert.deepEqual(readRegistry(regFile).sets.emil.exclude, ["animate"]);
  assert.ok(!fs.existsSync(path.join(t.paths.skillsDir, "animate")));
  assert.ok(!fs.lstatSync(path.join(t.paths.links[0], "animate"), { throwIfNoEntry: false }));
});

test("namespace: plan shows the new names, --dry-run saves nothing, update applies it", () => {
  const t = sandbox();
  assert.equal(t.skl("update", "emil", "-y").status, 0);
  const regFile = path.join(t.home, ".config", "skillport", "registry.json");
  const dry = t.skl("namespace", "emil", "emil", "--dry-run");
  assert.match(dry.stdout, /animate → emil-animate/);
  assert.equal((readRegistry(regFile).sets.emil as { namespace?: string }).namespace, undefined);
  assert.equal(t.skl("namespace", "emil", "emil", "-y").status, 0);
  assert.equal((readRegistry(regFile).sets.emil as { namespace?: string }).namespace, "emil");
  assert.equal(t.skl("update", "emil", "-y").status, 0);
  assert.ok(fs.existsSync(path.join(t.paths.skillsDir, "emil-animate", "SKILL.md")));
  assert.equal(t.skl("namespace", "emil", "--off", "-y").status, 0);
  assert.equal((readRegistry(regFile).sets.emil as { namespace?: string }).namespace, undefined);
});

test("update -y lists a new vendor skill but does not install it", () => {
  const t = sandbox();
  assert.equal(t.skl("update", "emil", "-y").status, 0);
  // The vendor now ships a second skill.
  const regFile = path.join(t.home, ".config", "skillport", "registry.json");
  const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
  reg.sets.emil.command[2] += `;const q=require("os").homedir()+"/.claude/skills/scroll";fs.mkdirSync(q,{recursive:true});fs.writeFileSync(q+"/SKILL.md","---\\nname: scroll\\ndescription: d\\n---\\n")`;
  fs.writeFileSync(regFile, JSON.stringify(reg));
  const r = t.skl("update", "emil", "-y");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /available +scroll/);
  assert.match(r.stdout, /skl update emil --pick/);
  assert.ok(!fs.existsSync(path.join(t.paths.skillsDir, "scroll")));
  assert.ok(fs.existsSync(path.join(t.paths.skillsDir, "animate")));
  assert.equal(JSON.parse(fs.readFileSync(regFile, "utf8")).sets.emil.skills, undefined);
});

test("bump: moves the pin to the latest version npm knows; refuses missing or older versions", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-bump-"));
  const paths = defaultPaths(home);
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // A stand-in npm: x has 1.0.0 and 1.2.0 (latest, published today).
  const today = new Date().toISOString();
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "view" && a[2] === "version") { console.log("1.2.0"); process.exit(0); }
if (a[0] === "view" && a[2] === "time") { console.log(JSON.stringify({ created: "2026-01-01T00:00:00Z", "1.0.0": "2026-01-01T00:00:00Z", "1.2.0": "${today}" })); process.exit(0); }
process.exit(1);
`,
  );
  fs.chmodSync(path.join(bin, "npm"), 0o755);
  fs.mkdirSync(path.dirname(paths.registry), { recursive: true });
  fs.writeFileSync(
    paths.registry,
    JSON.stringify({
      version: 1,
      sets: {
        pkg: { type: "npm", package: "x@1.0.0", path: "skills" },
        inst: { type: "installer", command: ["npx", "x@1.0.0", "--global"], unattended: [] },
      },
    }),
  );
  const skl = (...args: string[]) =>
    spawnSync(BIN, args, { env: { ...process.env, SKILLPORT_HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  const sets = () => readRegistry(paths.registry).sets as Record<string, { package?: string; command?: string[] }>;

  const dry = skl("bump", "pkg", "--dry-run");
  assert.match(dry.stdout, /x 1\.0\.0 → 1\.2\.0/);
  assert.match(dry.stdout, /today/);
  assert.match(dry.stdout, /very new/);
  assert.equal(sets().pkg.package, "x@1.0.0");

  assert.equal(skl("bump", "pkg", "-y").status, 0);
  assert.equal(sets().pkg.package, "x@1.2.0");
  assert.equal(skl("bump", "inst", "-y").status, 0);
  assert.deepEqual(sets().inst.command, ["npx", "x@1.2.0", "--global"]);

  const missing = skl("bump", "pkg", "9.9.9", "-y");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not exist on npm/);
  const older = skl("bump", "pkg", "1.0.0", "-y");
  assert.match(older.stdout, /nothing to bump/);
  assert.equal(sets().pkg.package, "x@1.2.0");
});

test("a registry link target gets links only from the sets that name it", () => {
  const t = sandbox({ links: ["claude-code", "claude-work"] });
  const file = t.paths.registry;
  const reg = JSON.parse(fs.readFileSync(file, "utf8"));
  reg.linkTargets = { "claude-work": { label: "Claude Code (work)", dir: "~/.claude-work/skills" } };
  reg.sets.plain = { ...reg.sets.emil, links: undefined, namespace: "plain" };
  fs.writeFileSync(file, JSON.stringify(reg));
  const work = path.join(t.home, ".claude-work", "skills");
  const dest = path.join(t.paths.skillsDir, "animate");
  assert.equal(t.skl("update", "-y").status, 0);
  assert.equal(fs.readlinkSync(path.join(t.paths.links[0], "animate")), dest);
  assert.equal(fs.readlinkSync(path.join(work, "animate")), dest);
  assert.ok(fs.lstatSync(path.join(t.paths.links[0], "plain-animate")).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(work, "plain-animate"), { throwIfNoEntry: false }));
  // Dropping the target from a set removes only that link.
  reg.sets.emil.links = ["claude-code"];
  fs.writeFileSync(file, JSON.stringify(reg));
  assert.equal(t.skl("update", "emil", "-y").status, 0);
  assert.ok(!fs.lstatSync(path.join(work, "animate"), { throwIfNoEntry: false }));
  assert.ok(fs.lstatSync(path.join(t.paths.links[0], "animate")).isSymbolicLink());
});

test("registry link targets are checked when the registry is read", () => {
  const t = sandbox();
  const file = t.paths.registry;
  const reg = JSON.parse(fs.readFileSync(file, "utf8"));
  const status = (linkTargets: unknown, links?: string[]) => {
    fs.writeFileSync(file, JSON.stringify({ ...reg, linkTargets, sets: { emil: { ...reg.sets.emil, links } } }));
    return t.skl("status").stderr;
  };
  assert.match(status({ "claude-code": { dir: "~/x/skills" } }), /"claude-code" is built in/);
  assert.match(status({ work: { dir: "relative/skills" } }), /dir must be an absolute folder or start with ~\//);
  assert.match(status({ work: { dir: "~/../skills" } }), /no \.\./);
  assert.match(status({ work: { dir: "~/.agents/skills" } }), /overlaps skillport's own folders/);
  assert.match(status({ work: { dir: "~/.claude/skills" } }), /another target already uses/);
  assert.match(status(undefined, ["claude-work"]), /links must be a list of: claude-code/);
  assert.match(status({ "claude-work": { dir: "~/w/skills" } }, ["claude-work"]), /^$/);
});
