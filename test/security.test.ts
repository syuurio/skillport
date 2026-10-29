import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { npmPack, realFolderPath, runInstaller } from "../src/acquire.ts";
import { addCommandLine, buildSource } from "../src/add.ts";
import { acquireLock } from "../src/apply.ts";
import { diagnose } from "../src/doctor.ts";
import { readManifest } from "../src/manifest.ts";
import { defaultPaths } from "../src/paths.ts";
import { extractSecret, githubRepo, installerProblems, isPinnedSpec, sourceProblem } from "../src/validate.ts";

const tmp = (label: string) => fs.mkdtempSync(path.join(os.tmpdir(), `skillport-sec-${label}-`));

test("N2: npm pack never sees a git, shorthand, URL or path spec, so no prepare script runs", () => {
  const repo = tmp("git");
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "evil", version: "1.0.0", scripts: { prepare: "node -e \"require('fs').writeFileSync('ran','x')\"" } }),
  );
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "x"], { cwd: repo });
  for (const spec of [`git+file://${repo}`, "owner/repo", "github:owner/repo", "https://x/y.tgz", repo, "motion-ai", "motion-ai@latest"]) {
    assert.ok(!isPinnedSpec(spec), spec);
    assert.throws(() => npmPack(spec, tmp("dst")), /not a registry package pinned/, spec);
  }
  assert.ok(!fs.existsSync(path.join(repo, "ran")));
  assert.ok(isPinnedSpec("motion-ai@14.1.0") && isPinnedSpec("@aiforui/install@0.1.4"));
});

test("N2: a hand-edited manifest source is validated when the manifest is read", () => {
  const file = path.join(tmp("reg"), "manifest.json");
  fs.writeFileSync(file, JSON.stringify({ version: 2, sources: { bad: { type: "npm", package: "owner/repo", path: "skills" } } }));
  assert.throws(() => readManifest(file), /package must be a registry package pinned/);
  fs.writeFileSync(file, JSON.stringify({ version: 2, sources: { h: { type: "installer", command: ["x"], unattended: [], harvest: "../.." } } }));
  assert.throws(() => readManifest(file), /harvest must be a folder inside/);
});

test("S7: every credential-looking flag is caught, paths and URLs are not", () => {
  for (const argv of [["--access-token=abc"], ["--license-key=abc"], ["--api-key", "abc"], ["--auth=abc"], ["--password", "p"]]) {
    assert.equal(extractSecret(["npx", "i", ...argv]).secret !== undefined, true, argv.join(" "));
  }
  assert.equal(extractSecret(["npx", "i", "--api=https://animations.dev"]).secret, undefined);
  assert.equal(extractSecret(["npx", "i", "--key-file=./k.pem"]).secret, undefined);
  assert.match(installerProblems({ command: ["npx", "i", "--access-token=abc"] }).join(), /literal token/);
});

test("N1: a lock taken over by another run in between is put back, not stolen", () => {
  const paths = defaultPaths(tmp("lock"));
  fs.mkdirSync(path.join(paths.sklDir, "lock.d"), { recursive: true });
  fs.writeFileSync(path.join(paths.sklDir, "lock.d", "pid"), "999999"); // dead
  // Make the rename land on a lock another live run (this test's parent) took meanwhile.
  const realRename = fs.renameSync;
  let once = true;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = (from, to) => {
    if (once && String(from).endsWith("lock.d")) {
      once = false;
      fs.writeFileSync(path.join(String(from), "pid"), String(process.ppid));
    }
    return realRename(from, to);
  };
  try {
    assert.throws(() => acquireLock(paths.sklDir), new RegExp(`pid ${process.ppid}`));
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
  }
  assert.equal(fs.readFileSync(path.join(paths.sklDir, "lock.d", "pid"), "utf8"), String(process.ppid));
});

test("C1: a doctor fix re-checks its target; your link that appeared meanwhile is left alone", () => {
  const home = tmp("doc");
  const paths = defaultPaths(home);
  fs.mkdirSync(paths.links[0], { recursive: true });
  const at = path.join(paths.links[0], "gone");
  fs.symlinkSync(path.join(paths.skillsDir, "gone"), at);
  const f = diagnose(paths, { version: 2, sources: {} }, { version: 2, sources: {}, skills: {} }).find((x) => x.kind === "broken-link");
  assert.ok(f?.fix);
  fs.unlinkSync(at);
  fs.mkdirSync(path.join(home, "mine"));
  fs.symlinkSync(path.join(home, "mine"), at);
  f.fix();
  assert.equal(fs.readlinkSync(at), path.join(home, "mine"));
});

test("a symlink above the skills folder (package/skills -> elsewhere) is refused", () => {
  const root = tmp("pkg");
  const elsewhere = tmp("local");
  fs.mkdirSync(path.join(elsewhere, "secret-notes"));
  fs.writeFileSync(path.join(elsewhere, "secret-notes", "SKILL.md"), "---\nname: secret-notes\n---\n");
  fs.symlinkSync(elsewhere, path.join(root, "skills"));
  assert.throws(() => realFolderPath(root, "skills"), /goes through a symlink/);
  fs.mkdirSync(path.join(root, "content"));
  fs.symlinkSync(elsewhere, path.join(root, "content", "skills"));
  assert.throws(() => realFolderPath(root, "content/skills"), /goes through a symlink \(skills\)/);
});

test("S7: credential words are matched whole: --license and --pat yes, --author and --keyboard no", () => {
  const found = (...argv: string[]) => extractSecret(["npx", "x@1.0.0", ...argv]).secret;
  assert.equal(found("--license", "ABCD-1234"), "ABCD-1234");
  assert.equal(found("--pat", "ghp_abc"), "ghp_abc");
  assert.equal(found("--author", "alice"), undefined);
  assert.equal(found("--keyboard=us"), undefined);
  assert.equal(found("--no-auth", "global"), undefined);
});

test("credential flags in camelCase are caught too", () => {
  for (const f of ["--accessToken=abc", "--authToken=abc", "--privateKey=abc", "--apiKey=abc", "--githubPat=abc"]) {
    assert.equal(extractSecret(["npx", "x@1.0.0", f]).secret, "abc", f);
  }
  assert.equal(extractSecret(["npx", "x@1.0.0", "--authorName=alice"]).secret, undefined);
});

test("the package root itself may not be a symlink", () => {
  const dir = tmp("root");
  const elsewhere = tmp("elsewhere");
  fs.symlinkSync(elsewhere, path.join(dir, "package"));
  assert.throws(() => realFolderPath(dir, "package"), /goes through a symlink \(package\)/);
});

test("round 4: credential matching skips file, method and license-id flags", () => {
  const found = (...argv: string[]) => extractSecret(["npx", "x@1.0.0", ...argv]).secret;
  assert.equal(found("--key-file", "id.pem"), undefined);
  assert.equal(found("--auth-method", "oauth"), undefined);
  assert.equal(found("--license", "MIT"), undefined);
  assert.equal(found("--license", "ABCD-1234-EFGH"), "ABCD-1234-EFGH");
  assert.equal(found("--accessToken=abc"), "abc");
});

test("exceptions do not open bypasses: a qualifier counts only as the last word, SPDX only on --license", () => {
  const found = (...argv: string[]) => extractSecret(["npx", "x@1.0.0", ...argv]).secret;
  assert.equal(found("--license-key=CC-ABCD-SECRET"), "CC-ABCD-SECRET");
  assert.equal(found("--host-token=abc"), "abc");
  assert.equal(found("--file-token", "abc"), "abc");
  assert.equal(found("--license", "Apache-2.0"), undefined);
  assert.equal(found("--license", "GPL-3.0-or-later"), undefined);
  assert.equal(found("--key-file", "id.pem"), undefined);
});

test("taking the lock clears lock folders set aside by runs that are gone", () => {
  const paths = defaultPaths(tmp("stale"));
  fs.mkdirSync(path.join(paths.sklDir, "lock.d.stale-1-0"), { recursive: true });
  fs.writeFileSync(path.join(paths.sklDir, "lock.d.stale-1-0", "pid"), "999999");
  acquireLock(paths.sklDir)();
  assert.ok(!fs.existsSync(path.join(paths.sklDir, "lock.d.stale-1-0")));
});

test("round 5: env assignments, slash-leading tokens and URLs with credentials are caught", () => {
  assert.deepEqual(extractSecret(["GITHUB_TOKEN=ghp_abc", "npx", "x@1.0.0"]), { command: ["GITHUB_TOKEN={secret}", "npx", "x@1.0.0"], secret: "ghp_abc" });
  assert.equal(extractSecret(["npx", "x@1.0.0", "--token", "/AbC+def=="]).secret, "/AbC+def==");
  assert.equal(extractSecret(["npx", "x@1.0.0", "--api-key=https://u:sk_live@h"]).secret, "sk_live");
  assert.equal(extractSecret(["npx", "x@1.0.0", "--key-path=/etc/ssl/k.pem"]).secret, undefined);
  assert.equal(extractSecret(["npx", "x@1.0.0", "--token-url=https://auth.example.com"]).secret, undefined);
  assert.equal(extractSecret(["npx", "x@1.0.0", "--license", "MIT-0"]).secret, undefined);
  assert.equal(extractSecret(["NODE_ENV=production", "npx", "x@1.0.0"]).secret, undefined);
});

test("round 5: GitHub sources match regardless of case", () => {
  assert.equal(githubRepo("https://github.com/Owner/Repo"), githubRepo("owner/repo"));
});

test("round 5: a lock folder without a pid that is not fresh is taken over", () => {
  const paths = defaultPaths(tmp("nopid"));
  const dir = path.join(paths.sklDir, "lock.d");
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(dir, old, old);
  acquireLock(paths.sklDir)();
});

test("round 6: credentials anywhere in a word are caught, and validation covers unattended and source", () => {
  const found = (...argv: string[]) => extractSecret(["npx", "x@1.0.0", ...argv]);
  assert.deepEqual(found("--registry", "https://me:npm_AbC123@npm.example.com/").command.slice(-1), ["https://me:{secret}@npm.example.com/"]);
  assert.equal(found("https://me:pw@host/x").secret, "pw");
  assert.equal(found("-t", "ghp_0123456789abcdefghij0123").secret, "ghp_0123456789abcdefghij0123");
  assert.equal(found("--header", "Authorization: Bearer abc.def").secret, "abc.def");
  assert.equal(found("--registry", "https://npm.example.com/").secret, undefined);
  const v = (set: unknown) => installerProblems(set as never).join();
  assert.match(v({ type: "installer", command: ["npx", "i"], unattended: ["--token", "ghp_0123456789abcdefghij0123"] }), /unattended contains a literal token/);
  assert.match(sourceProblem("https://me:ghp_0123456789abcdefghij0123@github.com/o/r.git") ?? "", /source contains a credential/);
});

test("round 6: a leading NAME={secret} word reaches the installer as environment, not argv", async () => {
  const staging = tmp("envrun");
  const out = path.join(staging, "seen");
  const set = {
    type: "installer" as const,
    command: ["DEMO_VAR=hello", "node", "-e", `const fs=require("fs"),p=require("os").homedir()+"/.claude/skills/a";fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+"/SKILL.md","x");fs.writeFileSync(${JSON.stringify(out)},process.env.DEMO_VAR)`],
    unattended: [],
  };
  runInstaller("demo", set, staging, { interactive: false });
  assert.equal(fs.readFileSync(out, "utf8"), "hello");
});

test("round 6: a takeover that would move a fresh pid-less lock puts it back", () => {
  const paths = defaultPaths(tmp("fresh"));
  const dir = path.join(paths.sklDir, "lock.d");
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(dir, old, old);
  // Between our staleness check and the rename, another run replaces it with a fresh lock.
  const realRename = fs.renameSync;
  let once = true;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = (from, to) => {
    if (once && String(from).endsWith("lock.d")) {
      once = false;
      fs.rmSync(String(from), { recursive: true });
      fs.mkdirSync(String(from));
    }
    return realRename(from, to);
  };
  try {
    // The fresh one gets put back; on retry it is fresh and pid-less, so we wait and finally give up.
    assert.throws(() => acquireLock(paths.sklDir), /Could not take the lock/);
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
  }
  assert.ok(fs.existsSync(dir));
});

test("round 7: embedded credentials behind any flag, real token formats, no false sk- match", () => {
  const ex = (...argv: string[]) => extractSecret(["npx", "x@1.0.0", ...argv]);
  assert.deepEqual(ex("--registry=https://alice:hunter2@npm.example.com/").command.slice(-1), ["--registry=https://alice:{secret}@npm.example.com/"]);
  assert.equal(ex("--header=Authorization: Bearer abc").secret, "abc");
  assert.equal(ex("sk-ant-api03-AbCd3fGh1jKlMn0pQrStUvWx").secret, "sk-ant-api03-AbCd3fGh1jKlMn0pQrStUvWx");
  assert.equal(ex("sk-proj-AbCd3fGh1jKlMn0pQrStUvWxYz").secret, "sk-proj-AbCd3fGh1jKlMn0pQrStUvWxYz");
  assert.equal(ex("@acme/risk-assessmentframework@1.0.0").secret, undefined);
  assert.equal(sourceProblem("acme/risk-assessmentframework"), undefined);
});

test("round 7: {secret} in unattended needs secret; env prefixes may not set sandbox variables", () => {
  const v = (set: unknown) => installerProblems(set as never).join();
  assert.match(v({ type: "installer", command: ["npx", "i"], unattended: ["--token={secret}"] }), /"secret" is not "keychain"/);
  assert.equal(v({ type: "installer", command: ["npx", "i"], unattended: ["--token={secret}"], secret: "keychain" }), "");
  assert.match(v({ type: "installer", command: ["HOME=/Users/me", "npx", "i"] }), /may not set HOME/);
  assert.match(v({ type: "installer", command: ["npm_config_logs_max=5", "npx", "i"] }), /may not set npm_config_logs_max/);
  assert.equal(v({ type: "installer", command: ["GITHUB_TOKEN={secret}", "npx", "i"], secret: "keychain" }), "");
});

test("round 8: sk- inside ordinary names is not a key; reserved env is one list for validation and running", async () => {
  // All lower case, but random: sk- plus 32 hex.
  assert.equal(extractSecret(["npx", "x@1.0.0", "sk-3f9a1c0e7b2d4a6f8e1c3b5d7f9a0c2e"]).secret, "sk-3f9a1c0e7b2d4a6f8e1c3b5d7f9a0c2e");
  assert.equal(extractSecret(["npx", "-y", "@acme/sk-design-system-installer"]).secret, undefined);
  assert.equal(sourceProblem("acme/sk-design-system-skills"), undefined);
  assert.equal(extractSecret(["npx", "x@1.0.0", "sk-AbCd3fGh1jKlMn0pQrStUvWx"]).secret, "sk-AbCd3fGh1jKlMn0pQrStUvWx");
  const v = (set: unknown) => installerProblems(set as never).join();
  // Allowed: pass-through settings a prefix may override.
  assert.equal(v({ type: "installer", command: ["HTTPS_PROXY=http://proxy:8080", "LANG=C", "npx", "i@1.0.0"], unattended: [] }), "");
  // Refused in any case, and wherever the run's prefix ends up.
  assert.match(v({ type: "installer", command: ["Npm_Config_Logs_Max=5", "npx", "i"] }), /may not set Npm_Config_Logs_Max/);
  assert.match(v({ type: "installer", command: ["X=1"], unattended: ["NODE_PATH=/evil", "npx", "i"] }), /may not set NODE_PATH/);
  // Running: the allowed prefix actually runs.
  const staging = tmp("proxy");
  const out = path.join(staging, "seen");
  runInstaller("p", {
    command: ["HTTPS_PROXY=http://proxy:8080", "node", "-e", `const fs=require("fs"),p=require("os").homedir()+"/.claude/skills/a";fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+"/SKILL.md","x");fs.writeFileSync(${JSON.stringify(out)},process.env.HTTPS_PROXY)`],
    unattended: [],
  }, staging, { interactive: false });
  assert.equal(fs.readFileSync(out, "utf8"), "http://proxy:8080");
});

test("round 8b: hyphenated sk- key forms are caught; lower-case names are not", () => {
  for (const k of ["sk-svcacct-AbC123dEf456GhI789jKl012MnO345", "sk-None-AbC123dEf456GhI789jKl012", "sk-admin-AbC123dEf456GhI789jKl0", "sk-ant-api03-AbCdEf123GhIjKl456MnOp", "sk-proj-AbCdEf123GhIjKl456MnOpQr"]) {
    assert.equal(extractSecret(["npx", "x@1.0.0", k]).secret, k, k);
  }
  // Upper case without digits is still a key: a false alarm shows up as {secret}, a miss leaks the key.
  assert.equal(extractSecret(["npx", "x@1.0.0", "sk-AbCdEfGhIjKlMnOpQrStUvWx"]).secret, "sk-AbCdEfGhIjKlMnOpQrStUvWx");
  // All lower case, but random: sk- plus 32 hex.
  assert.equal(extractSecret(["npx", "x@1.0.0", "sk-3f9a1c0e7b2d4a6f8e1c3b5d7f9a0c2e"]).secret, "sk-3f9a1c0e7b2d4a6f8e1c3b5d7f9a0c2e");
  assert.equal(extractSecret(["npx", "-y", "@acme/sk-design-system-installer"]).secret, undefined);
  assert.equal(sourceProblem("acme/sk-design-system-skills-2024"), undefined);
});

test("round 8c: a name-like sk- match earlier in a word does not hide a key", () => {
  const k = "sk-proj-AbCd3fGh1jKlMn0pQrStUvWxYz";
  assert.equal(extractSecret(["npx", "x@1.0.0", `--from=sk-design-system-skills-pack,${k}`]).secret, k);
});


test("the skl add repeated in a name-clash fix never shows the installer's token", () => {
  const args = ["vend", "--installer", "npx -y @v/install@0.1.4 --token=s3cr3t-value-123 --global", "--no-prefix", "-y"];
  const { source, token } = buildSource({ kind: "installer", value: args[2], prefix: false });
  assert.equal(token, "s3cr3t-value-123");
  const line = addCommandLine(args, source);
  assert.ok(!line.includes("s3cr3t"), line);
  assert.equal(line, "skl add vend --installer 'npx -y @v/install@0.1.4 --token={secret} --global' --no-prefix -y");
});
