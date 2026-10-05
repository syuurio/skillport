import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Registry, SkillSet } from "../src/registry.ts";
import { countSkillRoots, packageIndex, splitCommand, suggestUnattendedFlag, validateSet } from "../src/register.ts";
import { extractSecret, isPinnedSpec as isPinned } from "../src/validate.ts";
import { localDate } from "../src/transform.ts";

const empty: Registry = { version: 1, sets: {} };

test("splitCommand handles words and quotes", () => {
  assert.deepEqual(splitCommand(`npx -y @a/install@1 --token={secret} --api="https://x y"`), [
    "npx", "-y", "@a/install@1", "--token={secret}", "--api=https://x y",
  ]);
  assert.deepEqual(splitCommand(`node -e '' --`), ["node", "-e", "", "--"]);
  assert.throws(() => splitCommand(`a "b`), /Unclosed quote/);
});

test("validateSet accepts good entries per type", () => {
  const ok: [string, SkillSet][] = [
    ["aiforui", { type: "installer", command: ["npx", "@aiforui/install@0.1.4", "--token={secret}", "--global"], unattended: ["-y"], secret: "keychain" }],
    ["motion", { type: "npm", package: "motion-ai@14.1.0", path: "content/skills" }],
    ["matt", { type: "skills-cli", source: "mattpocock/skills" }],
  ];
  for (const [id, set] of ok) assert.deepEqual(validateSet(id, set, empty), [], id);
});

test("validateSet rejects unsafe or ambiguous entries", () => {
  const bad = (id: string, set: unknown) => validateSet(id, set as SkillSet, { version: 1, sets: { taken: { type: "skills-cli", source: "a/b" } } });
  assert.match(bad("..", { type: "skills-cli", source: "a/b" }).join(), /set id/);
  assert.match(bad("taken", { type: "skills-cli", source: "a/b" }).join(), /already exists/);
  assert.match(bad("x", { type: "installer", command: ["npx", "i", "--token=abc123"] }).join(), /literal token/);
  assert.match(bad("x", { type: "installer", command: ["npx", "i"], secret: "keychain" }).join(), /no command word contains \{secret\}/);
  assert.match(bad("x", { type: "npm", package: "motion-ai", path: "skills" }).join(), /pinned/);
  assert.match(bad("x", { type: "npm", package: "a@1", path: "../x" }).join(), /inside the package/);
  assert.match(bad("x", { type: "nope" }).join(), /type must be/);
});

test("register --json writes a validated entry; without a terminal it needs --json", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-reg-"));
  const run = (...args: string[]) =>
    spawnSync(path.join(import.meta.dirname, "..", "bin", "skillport"), args, {
      env: { ...process.env, SKILLPORT_HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  assert.match(run("register", "newvendor").stderr, /without a terminal.*--json/);
  const entry = { type: "installer", command: ["npx", "@nv/install@1.0.0", "--token={secret}"], unattended: ["--yes"], secret: "keychain" };
  assert.match(run("register", "newvendor", "--json", JSON.stringify(entry)).stderr, /pass -y/);
  assert.match(run("register", "newvendor", "--json", JSON.stringify(entry), "--dry-run").stdout, /dry run: registry unchanged/);
  const r = run("register", "newvendor", "--json", JSON.stringify(entry), "-y");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skl secret newvendor/);
  const reg = JSON.parse(fs.readFileSync(path.join(home, ".config", "skillport", "registry.json"), "utf8"));
  assert.deepEqual(reg.sets.newvendor, entry);
  assert.match(run("register", "newvendor", "--json", JSON.stringify(entry), "-y").stderr, /already exists/);
});

test("extractSecret moves a pasted token out of the command", () => {
  assert.deepEqual(extractSecret(["npx", "@v/i", "--token=abc123", "--global"]), {
    command: ["npx", "@v/i", "--token={secret}", "--global"],
    secret: "abc123",
  });
  assert.deepEqual(extractSecret(["npx", "@v/i", "--api-key", "abc", "-y"]), {
    command: ["npx", "@v/i", "--api-key={secret}", "-y"],
    secret: "abc",
  });
  assert.deepEqual(extractSecret(["npx", "@v/i", "--token={secret}"]), { command: ["npx", "@v/i", "--token={secret}"] });
  assert.deepEqual(extractSecret(["npx", "@v/i", "--global"]), { command: ["npx", "@v/i", "--global"] });
});

test("packageIndex and isPinned find and judge the package an npx command runs", () => {
  assert.equal(packageIndex(["npx", "-y", "@aiforui/install", "--token={secret}"]), 2);
  assert.equal(packageIndex(["pnpm", "dlx", "foo@1.0.0"]), 2);
  assert.equal(packageIndex(["./install.sh"]), -1);
  assert.ok(isPinned("@aiforui/install@0.1.4"));
  assert.ok(isPinned("foo@1.0.0"));
  assert.ok(!isPinned("@aiforui/install"));
  assert.ok(!isPinned("foo@latest"));
});

test("suggestUnattendedFlag finds the documented don't-ask flag", () => {
  assert.equal(suggestUnattendedFlag("  -y, --yes   Non-interactive: install everything"), "-y");
  assert.equal(suggestUnattendedFlag("Options:\n  --yes  skip prompts"), "--yes");
  assert.equal(suggestUnattendedFlag("  --non-interactive  never prompt"), "--non-interactive");
  assert.equal(suggestUnattendedFlag("  --yesterday  show yesterday"), null);
  assert.equal(suggestUnattendedFlag("no flags here"), null);
});

test("validateSet checks link targets", () => {
  assert.deepEqual(validateSet("a", { type: "npm", package: "x@1.0.0", path: "s", links: ["claude-code"] }, empty), []);
  assert.deepEqual(validateSet("a", { type: "npm", package: "x@1.0.0", path: "s", links: [] }, empty), []);
  assert.match(validateSet("a", { type: "npm", package: "x@1.0.0", path: "s", links: ["grok"] }, empty).join(), /links must be/);
});

test("countSkillRoots lists every folder in a package that holds skills, most first", () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "skillport-pkg-"));
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "fixture-skills", version: "1.0.0" }));
  const skill = (dir: string) => {
    fs.mkdirSync(path.join(pkg, dir), { recursive: true });
    fs.writeFileSync(path.join(pkg, dir, "SKILL.md"), "---\nname: x\n---\n");
  };
  skill("skills/a");
  skill("skills/b");
  skill("extras/c");
  assert.deepEqual(countSkillRoots(pkg), [{ root: "skills", count: 2 }, { root: "extras", count: 1 }]);
});

test("localDate uses the local calendar day", () => {
  assert.equal(localDate(new Date(2026, 9, 6, 0, 30)), "2026-10-06");
});

test("validateSet refuses every literal token form and a {secret} without secret", () => {
  const bad = (command: string[], secret?: "keychain") =>
    validateSet("x", { type: "installer", command, ...(secret ? { secret } : {}) }, empty).join();
  assert.match(bad(["npx", "i", "--api-key=abc"]), /literal token/);
  assert.match(bad(["npx", "i", "--token", "abc"]), /literal token/);
  assert.match(bad(["npx", "i", "--auth=abc"]), /literal token/);
  assert.match(bad(["npx", "i", "--token={secret}"]), /"secret" is not "keychain"/);
  assert.equal(bad(["npx", "i", "--token={secret}"], "keychain"), "");
});
