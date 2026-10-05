import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { npmPack, realFolderPath } from "../src/acquire.ts";
import { acquireLock } from "../src/apply.ts";
import { diagnose } from "../src/doctor.ts";
import { defaultPaths, readRegistry } from "../src/registry.ts";
import { extractSecret, isPinnedSpec, validateEntry } from "../src/validate.ts";

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

test("N2: a hand-edited registry entry is validated when the registry is read", () => {
  const home = tmp("reg");
  const file = path.join(home, "registry.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, sets: { bad: { type: "npm", package: "owner/repo", path: "skills" } } }));
  assert.throws(() => readRegistry(file), /bad: package must be a registry package pinned/);
  fs.writeFileSync(file, JSON.stringify({ version: 1, sets: { h: { type: "installer", command: ["x"], unattended: [], harvest: "../.." } } }));
  assert.throws(() => readRegistry(file), /harvest must be a folder inside/);
});

test("S7: every credential-looking flag is caught, paths and URLs are not", () => {
  for (const argv of [["--access-token=abc"], ["--license-key=abc"], ["--api-key", "abc"], ["--auth=abc"], ["--password", "p"]]) {
    assert.equal(extractSecret(["npx", "i", ...argv]).secret !== undefined, true, argv.join(" "));
  }
  assert.equal(extractSecret(["npx", "i", "--api=https://animations.dev"]).secret, undefined);
  assert.equal(extractSecret(["npx", "i", "--key-file=./k.pem"]).secret, undefined);
  assert.match(validateEntry("x", { type: "installer", command: ["npx", "i", "--access-token=abc"] }, []).join(), /literal token/);
});

test("N1: a lock taken over by another run in between is put back, not stolen", () => {
  const paths = defaultPaths(tmp("lock"));
  fs.mkdirSync(path.join(paths.stateDir, "lock.d"), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, "lock.d", "pid"), "999999"); // dead
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
    assert.throws(() => acquireLock(paths), new RegExp(`pid ${process.ppid}`));
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
  }
  assert.equal(fs.readFileSync(path.join(paths.stateDir, "lock.d", "pid"), "utf8"), String(process.ppid));
});

test("C1: a doctor fix re-checks its target; your link that appeared meanwhile is left alone", () => {
  const home = tmp("doc");
  const paths = defaultPaths(home);
  fs.mkdirSync(paths.links[0], { recursive: true });
  const at = path.join(paths.links[0], "gone");
  fs.symlinkSync(path.join(paths.skillsDir, "gone"), at);
  const f = diagnose(paths, { version: 1, sets: {} }, { version: 1, sets: {} }, {}).find((x) => x.kind === "broken-link");
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

test("registry rules and lists are checked for shape", () => {
  const bad = (extra: Record<string, unknown>) =>
    validateEntry("x", { type: "npm", package: "a@1.0.0", path: "s", ...extra } as never, []).join();
  assert.match(bad({ rename: { prototype: "anim-prototype" } }), /rename must map/);
  assert.match(bad({ skills: "tdd" }), /skills must be a list/);
  assert.match(bad({ exclude: ["../x"] }), /exclude must be a list/);
  assert.match(bad({ prefix: "My_Set" }), /prefix must be/);
  assert.equal(bad({ rename: { prototype: { to: "anim-prototype", reason: "x", at: "" } }, skills: ["tdd"] }), "");
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

test("round 4: a skill installed by hand from the same source is never adopted or removed", async () => {
  const { planCli } = await import("../src/skillscli.ts");
  const paths = defaultPaths(tmp("own4"));
  const lock = { mine: { source: "acme/skills", skillPath: "", skillFolderHash: "", updatedAt: "" } };
  const p = planCli({ paths, setId: "acme", set: { type: "skills-cli", source: "acme/skills" }, available: ["mine", "other"], lock, state: { version: 1, sets: {} } });
  assert.deepEqual(p.update, []);
  assert.deepEqual(p.remove, []);
  assert.deepEqual(p.others, ["mine"]);
  assert.deepEqual([...p.add, ...p.update], ["other"]); // what would be recorded as owned
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
