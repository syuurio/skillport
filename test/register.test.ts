import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Registry, SkillSet } from "../src/registry.ts";
import { splitCommand, validateSet } from "../src/register.ts";

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
  assert.match(run("register", "newvendor").stderr, /pass --json/);
  const entry = { type: "installer", command: ["npx", "@nv/install@1.0.0", "--token={secret}"], unattended: ["--yes"], secret: "keychain" };
  const r = run("register", "newvendor", "--json", JSON.stringify(entry));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skl secret newvendor/);
  const reg = JSON.parse(fs.readFileSync(path.join(home, ".config", "skillport", "registry.json"), "utf8"));
  assert.deepEqual(reg.sets.newvendor, entry);
  assert.match(run("register", "newvendor", "--json", JSON.stringify(entry)).stderr, /already exists/);
});
