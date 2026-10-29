import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildSource } from "../src/add.ts";
import { skillsIn } from "../src/adapters/index.ts";
import { fetchInstaller } from "../src/adapters/installer.ts";
import { readLock } from "../src/lock.ts";
import { type InstallerSource, type SourceId, parseManifest } from "../src/manifest.ts";
import { defaultPaths, withLinkTargets } from "../src/registry.ts";
import { sync } from "../src/sync.ts";

const TOKEN = "tok_9f8e7d6c5b4a3210";

/** An installer that writes skills for two agents, a file at HOME, and prints its token. */
function fakeInstaller(dir: string, exit = 0): string {
  const script = path.join(dir, "install.mjs");
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
import path from "node:path";
const home = process.env.HOME;
const skill = (rel, name) => {
  fs.mkdirSync(path.join(home, rel, name), { recursive: true });
  fs.writeFileSync(path.join(home, rel, name, "SKILL.md"), "---\\nname: " + name + "\\ndescription: d\\n---\\nUse the \`beta\` skill.\\n");
};
skill(".claude/skills", "alpha");
skill(".claude/skills", "beta");
skill(".codex/skills", "codex-only");
fs.writeFileSync(path.join(home, "skl-adapter-marker"), "x");
console.log("token=" + process.argv.find((a) => a.startsWith("--token=")).slice(8));
process.exit(${exit});
`,
  );
  return script;
}

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skl-adapter-"));
  const script = fakeInstaller(home);
  const source: InstallerSource = {
    type: "installer",
    command: [process.execPath, script, "--token={secret}"],
    unattended: [],
    secret: "keychain",
  };
  const staging = path.join(home, "staging");
  return { home, script, source, staging };
}

test("the installer adapter takes only .claude/skills from a fake HOME", () => {
  const { home, source, staging } = sandbox();
  const fetched = fetchInstaller("vend" as SourceId, source, { staging, interactive: false, home, secret: TOKEN });
  assert.deepEqual(fetched.skills.map((s) => s.original), ["alpha", "beta"]);
  assert.ok(fetched.skills.every((s) => s.dir.startsWith(path.join(staging, "home", ".claude", "skills"))));
  assert.ok(fs.existsSync(path.join(staging, "home", "skl-adapter-marker")), "HOME was the fake one");
  assert.equal(fs.existsSync(path.join(os.homedir(), "skl-adapter-marker")), false, "real HOME untouched");
});

test("an installer's output is redacted when it fails", () => {
  const { home, source, staging } = sandbox();
  fakeInstaller(home, 3);
  assert.throws(
    () => fetchInstaller("vend" as SourceId, source, { staging, interactive: false, home, secret: TOKEN }),
    (e: Error) => /exited 3/.test(e.message) && e.message.includes("token=***") && !e.message.includes(TOKEN),
  );
});

test("a token typed into --installer goes to Keychain, never the manifest", () => {
  const { source, token } = buildSource({ kind: "installer", value: `npx -y @v/install@1.0.0 --token=${TOKEN} --global`, unattended: "-y" });
  assert.equal(token, TOKEN);
  assert.deepEqual(source, {
    type: "installer",
    command: ["npx", "-y", "@v/install@1.0.0", "--token={secret}", "--global"],
    unattended: ["-y"],
    secret: "keychain",
  });
  assert.doesNotThrow(() => parseManifest({ version: 2, sources: { vend: source } }, "manifest.json"));
  assert.equal(JSON.stringify(source).includes(TOKEN), false);
});

test("buildSource: npm, local and prefix", () => {
  assert.deepEqual(buildSource({ kind: "npm", value: "motion-ai@14.1.0", path: "content/skills", prefix: false }).source, {
    type: "npm",
    package: "motion-ai@14.1.0",
    path: "content/skills",
    prefix: false,
  });
  assert.deepEqual(buildSource({ kind: "local", value: "skills", prefix: "me" }, "/work").source, { type: "local", path: "/work/skills", prefix: "me" });
});

test("a vendor name that is not a skill name is refused before it becomes a path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skl-names-"));
  fs.mkdirSync(path.join(root, "evil"));
  fs.writeFileSync(path.join(root, "evil", "SKILL.md"), "---\nname: ../../escape\n---\n");
  assert.throws(() => skillsIn(root), /evil: "\.\.\/\.\.\/escape"/);
});

test("fetched installer skills are stored, rendered and linked by sync", () => {
  const { home, source, staging } = sandbox();
  const paths = withLinkTargets(defaultPaths(home), {});
  const manifest = parseManifest({ version: 2, sources: { vend: source } }, "manifest.json");
  const fetched = fetchInstaller("vend" as SourceId, source, { staging, interactive: false, home, secret: TOKEN });
  const lines = sync(paths, manifest, readLock(paths.lockFile), { fetched: new Map([["vend" as SourceId, fetched]]) });
  assert.deepEqual(lines.filter((l) => !l.startsWith(" ")), ["vend/alpha -> vend-alpha", "vend/beta -> vend-beta"]);
  assert.match(fs.readFileSync(path.join(paths.skillsDir, "vend-alpha", "SKILL.md"), "utf8"), /`vend-beta` skill/);
  assert.equal(readLock(paths.lockFile).sources["vend" as SourceId].resolved.length, 40);
  // Offline afterwards: the store has what the lock names.
  fs.rmSync(staging, { recursive: true });
  assert.deepEqual(sync(paths, manifest, readLock(paths.lockFile)), []);
});
