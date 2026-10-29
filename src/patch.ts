import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillName, SourceId } from "./manifest.ts";
import type { Paths } from "./paths.ts";

// Customizations as patches against the vendor's original-name folder, and
// the three-way merge that carries them across upstream changes. See
// docs/SPEC.md §5.5 and §10.

export function patchFiles(paths: Paths, source: SourceId, original: SkillName) {
  const dir = path.join(paths.patchesDir, source);
  return { patch: path.join(dir, `${original}.patch`), note: path.join(dir, `${original}.note.md`) };
}

export function mergeDir(paths: Paths, source: SourceId, original: SkillName): string {
  return path.join(paths.sklDir, "merge", source, original);
}

/** What a conflict was between, so `skl edit` can finish it against the right upstream. */
export interface MergeInfo {
  /** The store hash the patch was made against. */
  base: string;
  /** The new upstream's store hash. */
  upstream: string;
}

export function readMergeInfo(dir: string): MergeInfo | null {
  const file = path.join(dir, "merge.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as MergeInfo) : null;
}

export const patchHash = (text: string) => createHash("sha1").update(text).digest("hex");

// git must not find a repository around these folders: inside one, apply
// reads patch paths from the top of that repository.
const gitEnv = (cwd: string) => ({ ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) });

function git(args: string[], cwd: string, input?: string) {
  return spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd, input, encoding: "utf8", env: gitEnv(cwd), maxBuffer: 64 * 1024 * 1024 });
}

function withTemp<T>(fn: (tmp: string) => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skl-patch-"));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const copyTree = (from: string, to: string) =>
  fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== ".DS_Store" });

/** A unified diff from folder `a` to folder `b`, with a/ and b/ paths; "" when they are the same. */
export function diffTrees(a: string, b: string): string {
  return withTemp((tmp) => {
    copyTree(a, path.join(tmp, "a"));
    copyTree(b, path.join(tmp, "b"));
    const r = git(["diff", "--no-index", "--binary", "--no-color", "--no-ext-diff", "--no-prefix", "--no-renames", "a", "b"], tmp);
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr.trim()}`);
    return r.stdout;
  });
}

/**
 * Header lines skl will not hand to git: a path that is absolute or climbs
 * with "..", a mode other than a regular file, a rename or copy. Headers
 * are the lines between "diff --git" and a file's first hunk.
 */
function unsafeHeaders(text: string): string[] {
  const bad: string[] = [];
  let header = false;
  const climbs = (p: string) => p.startsWith("/") || p.split("/").includes("..");
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      const paths = line.slice("diff --git ".length);
      if (!/^[ab]\/.* [ab]\/.*$/.test(paths) || paths.split(" ").some((part) => climbs(part.replace(/^[ab]\//, "")))) bad.push(line);
      continue;
    }
    if (!header) continue;
    if (line.startsWith("@@")) header = false;
    else if (/^(---|\+\+\+) /.test(line)) {
      const p = line.slice(4);
      if (p !== "/dev/null" && (!/^[ab]\//.test(p) || climbs(p.slice(2)))) bad.push(line);
    } else if (/^(new file|deleted file|new|old) mode /.test(line)) {
      if (!/ 100(644|755)$/.test(line)) bad.push(line);
    } else if (/^(rename|copy) (from|to) /.test(line)) bad.push(line);
  }
  return bad;
}

function gitApply(dir: string, text: string, extra: string[]) {
  // git runs from an empty folder of ours: started inside `dir`, a .git that
  // vendor content brought would be read as a repository, config included.
  // --unsafe-paths lets --directory point outside that folder, so the check
  // it turns off (paths stay inside the target) is unsafeHeaders.
  const bad = unsafeHeaders(text);
  if (bad.length) throw new Error(`the patch has paths or modes skl does not apply: ${bad.join("; ")}`);
  return withTemp((tmp) => git(["apply", "-p1", "--whitespace=nowarn", "--unsafe-paths", `--directory=${fs.realpathSync(dir)}`, ...extra, "-"], tmp, text));
}

/** Apply a patch from diffTrees to `dir` in place; throws with git's reason when it does not apply. */
export function applyPatch(dir: string, text: string): void {
  const r = gitApply(dir, text, []);
  if (r.status !== 0) throw new Error(r.stderr.trim() || "git apply failed");
}

/** Apply what fits; each hunk that does not lands next to its file as `<file>.rej`. Returns those files. */
export function applyPatchPartly(dir: string, text: string): string[] {
  gitApply(dir, text, ["--reject"]);
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".rej"))
    .sort();
}

interface Entry {
  data: Buffer;
  exec: boolean;
}

function filesIn(dir: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || e.name === ".DS_Store") continue;
    const file = path.join(e.parentPath, e.name);
    out.set(path.relative(dir, file), { data: fs.readFileSync(file), exec: (fs.statSync(file).mode & 0o111) !== 0 });
  }
  return out;
}

const same = (x: Entry | undefined, y: Entry | undefined) => (!x || !y ? x === y : x.exec === y.exec && x.data.equals(y.data));

/**
 * Three-way merge of folders, file by file, into `out`: a change on one side
 * wins, the same change on both is taken once, and text both sides changed
 * goes through `git merge-file`. Returns the files that conflict; `out`
 * then holds conflict markers in them (or yours, when there is no text to
 * merge).
 */
export function mergeTrees(base: string, yours: string, upstream: string, out: string): string[] {
  const [b, y, u] = [filesIn(base), filesIn(yours), filesIn(upstream)];
  const conflicts: string[] = [];
  fs.mkdirSync(out, { recursive: true });
  const put = (rel: string, e: Entry | undefined) => {
    if (!e) return;
    const file = path.join(out, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, e.data);
    fs.chmodSync(file, e.exec ? 0o755 : 0o644);
  };
  for (const rel of [...new Set([...b.keys(), ...y.keys(), ...u.keys()])].sort()) {
    const [be, ye, ue] = [b.get(rel), y.get(rel), u.get(rel)];
    if (same(ye, be)) put(rel, ue);
    else if (same(ue, be) || same(ye, ue)) put(rel, ye);
    else if (be && ye && ue) {
      const exec = ye.exec !== be.exec ? ye.exec : ue.exec;
      const merged = mergeFile(be.data, ye.data, ue.data);
      if (!merged.clean) conflicts.push(rel);
      put(rel, { data: merged.data ?? ye.data, exec });
    } else {
      // Added on both sides, or changed on one and deleted on the other.
      conflicts.push(rel);
      put(rel, ye ?? ue);
    }
  }
  return conflicts;
}

function mergeFile(base: Buffer, yours: Buffer, upstream: Buffer): { clean: boolean; data?: Buffer } {
  return withTemp((tmp) => {
    const at = (n: string, d: Buffer) => (fs.writeFileSync(path.join(tmp, n), d), n);
    const r = spawnSync("git", ["merge-file", "-p", "-L", "YOURS", "-L", "BASE", "-L", "UPSTREAM", at("y", yours), at("b", base), at("u", upstream)], {
      cwd: tmp,
      env: gitEnv(tmp),
      maxBuffer: 64 * 1024 * 1024,
    });
    // The exit status counts conflicts; above 127 git refused (binary files).
    if (r.status === null || r.status > 127) return { clean: false };
    return { clean: r.status === 0, data: r.stdout };
  });
}
