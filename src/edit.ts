import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moveToTrash, trashDir } from "./apply.ts";
import type { Lock, SkillLock } from "./lock.ts";
import { type Manifest, type SkillId, type SkillName, type SourceId, installedName, splitSkillId } from "./manifest.ts";
import { applyPatch, diffTrees, mergeDir, mergeTrees, patchFiles, readMergeInfo, removeMerge } from "./patch.ts";
import type { Paths } from "./paths.ts";
import { markdownFiles, render } from "./render.ts";
import { home } from "./report.ts";
import { storedAt } from "./store.ts";
import { type SyncChange, describeSync, sync } from "./sync.ts";
import { readFrontmatterName, rewriteReferences, setFrontmatterName } from "./transform.ts";
import { treeHash } from "./treehash.ts";

// `skl edit`: customize a skill as a patch against the vendor's original-name
// folder, so prefixes and updates never lose it (SPEC §10). You (or an agent)
// change the installed folder and --from-disk turns that into the patch; a
// merge is resolved in its MERGED folder and plain `skl edit` finishes it.

export type EditMode = "finish" | "drop" | "from-disk";

export interface EditOptions {
  /** Why you made the change; replaces the note. Without it, the note is asked for once. */
  note?: string;
  /** Print the patch that would be saved; write nothing. */
  dryRun?: boolean;
  /** Why you made the change, or "" to skip; replaced in tests. */
  askNote(): Promise<string>;
}

function target(paths: Paths, manifest: Manifest, lock: Lock, arg: string | undefined): { id: SkillId; source: SourceId; original: SkillName; entry: SkillLock } {
  if (!arg?.includes("/")) throw new Error('Usage: skl edit <source>/<skill> [--from-disk | --drop] [--note "<why>"] [--dry-run]');
  const id = arg as SkillId;
  const { source, original } = splitSkillId(id);
  if (!manifest.sources[source]) throw new Error(`Unknown source ${source}. Known: ${Object.keys(manifest.sources).join(", ")}`);
  const entry = lock.skills[id];
  if (entry) return { id, source, original, entry };
  // A patch that did not apply on a first install (a new machine): the skill
  // waits on its merge folder, and finishing it installs it.
  const info = readMergeInfo(mergeDir(paths, source, original));
  if (!info) throw new Error(`${id} is not installed; skl edit works on installed skills`);
  return { id, source, original, entry: { name: installedName(source, original, manifest.sources[source]), base: info.upstream, output: "", updatedAt: "" } };
}

/** The skill as you customized it, under its original name: base plus your patch. */
function yoursAt(paths: Paths, source: SourceId, original: SkillName, base: string, to: string): void {
  fs.cpSync(storedAt(paths, source, original, base), to, { recursive: true });
  const file = patchFiles(paths, source, original).patch;
  if (fs.existsSync(file)) applyPatch(to, fs.readFileSync(file, "utf8"));
}

/** Writes the patch, or removes it when there is no difference; writes the note given, or asks for one the first time. */
async function savePatch(paths: Paths, source: SourceId, original: SkillName, text: string, opts: EditOptions): Promise<string[]> {
  const { patch, note } = patchFiles(paths, source, original);
  if (opts.dryRun) return text ? [`would save ${home(patch)}:`, text.trimEnd()] : ["no changes; nothing would be saved"];
  if (!text) {
    if (!fs.existsSync(patch)) return ["no changes; nothing saved"];
    fs.rmSync(patch);
    return [`no changes left; removed ${home(patch)}`];
  }
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, text);
  const lines = [`saved ${home(patch)}`];
  if (opts.note?.trim()) {
    fs.writeFileSync(note, `${opts.note.trim()}\n`);
    lines.push(`saved ${home(note)}`);
  } else if (!fs.existsSync(note)) {
    const why = await opts.askNote();
    if (why) {
      fs.writeFileSync(note, `${why}\n`);
      lines.push(`saved ${home(note)}`);
    } else lines.push(`no note; write why in ${home(note)} so a merge knows what you meant`);
  }
  return lines;
}

const shown = (changes: SyncChange[]) => describeSync(changes.filter((c) => c.kind !== "offered"));

export async function edit(paths: Paths, manifest: Manifest, lock: Lock, arg: string | undefined, mode: EditMode, opts: EditOptions): Promise<string[]> {
  const { id, source, original, entry } = target(paths, manifest, lock, arg);
  const files = patchFiles(paths, source, original);
  const merge = mergeDir(paths, source, original);
  const dest = path.join(paths.skillsDir, entry.name);
  const edited = fs.existsSync(dest) && treeHash(dest) !== entry.output;

  if (mode === "drop") {
    if (!fs.existsSync(files.patch)) throw new Error(`${id} has no patch`);
    if (opts.dryRun) return [`would drop ${home(files.patch)} and install ${id} as upstream ships it`];
    const trash = trashDir(paths.sklDir, "edit");
    moveToTrash(trash, files.patch);
    moveToTrash(trash, files.note);
    removeMerge(paths, source, original);
    return [`dropped the patch for ${id} (moved to ${home(trash)})`, ...shown(sync(paths, manifest, lock))];
  }

  // A dry run takes no lock, so it works outside skl's folder.
  const workRoot = opts.dryRun ? fs.mkdtempSync(path.join(os.tmpdir(), "skl-edit-")) : path.join(paths.sklDir, "work", source);
  const work = path.join(workRoot, original);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });
  try {
    if (mode === "from-disk") {
      if (!edited) throw new Error(`${entry.name} is as skl wrote it; nothing to take from disk`);
      fromDisk(paths, lock, id, entry, dest, work);
      const lines = await savePatch(paths, source, original, diffTrees(storedAt(paths, source, original, entry.base), work), opts);
      if (opts.dryRun) return lines;
      // What is on disk is now exactly what skl renders, so it is no longer an edit.
      entry.output = treeHash(dest);
      return [...lines, ...shown(sync(paths, manifest, lock))];
    }

    if (edited) {
      throw new Error(
        `${entry.name} was changed in place in ~/.agents/skills.\n  keep those edits: skl edit ${id} --from-disk\n  discard them:     skl sync --discard-edits`,
      );
    }
    // A merge is resolved in MERGED itself, so work in progress survives a
    // second try; the patch is then against the new upstream.
    const info = readMergeInfo(merge);
    if (!info) {
      throw new Error(`${id} has no merge to finish. To customize it, change ${home(dest)}, then run:\n  skl edit ${id} --from-disk --note "<why>"`);
    }
    const against = info.upstream;
    const editing = path.join(merge, "MERGED");
    const rejects = fs.readdirSync(editing, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".rej"));
    if (rejects.length) {
      throw new Error(`Apply the hunks in ${rejects.join(", ")} by hand, then delete those files and run skl edit ${id} again. Your changes stay in ${home(editing)}.`);
    }
    const conflicted = markdownFiles(editing).filter((f) => /^(<<<<<<< YOURS|>>>>>>> UPSTREAM)$/m.test(fs.readFileSync(f, "utf8")));
    if (conflicted.length) {
      throw new Error(`Resolve the conflict markers in ${conflicted.map((f) => path.relative(editing, f)).join(", ")} first. They are in ${home(editing)}.`);
    }
    const lines = await savePatch(paths, source, original, diffTrees(storedAt(paths, source, original, against), editing), opts);
    if (opts.dryRun) return lines;
    lock.skills[id] = { ...entry, base: against };
    removeMerge(paths, source, original);
    return [...lines, ...shown(sync(paths, manifest, lock))];
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    if (!fs.readdirSync(workRoot).length) fs.rmdirSync(workRoot);
    const all = path.join(paths.sklDir, "work");
    if (!opts.dryRun && fs.existsSync(all) && !fs.readdirSync(all).length) fs.rmdirSync(all);
  }
}

/**
 * Undo skl's own changes on your edited folder, then check the result renders
 * back to exactly that folder. Two ways, the first that checks out wins:
 * reverse each rewrite (name, skl-* keys, references), or merge your edits
 * onto the unrendered folder with what skl wrote as the base. When neither
 * does, you changed a line skl also rewrites, which cannot be told apart.
 */
function fromDisk(paths: Paths, lock: Lock, id: SkillId, entry: SkillLock, dest: string, out: string): void {
  const { source, original } = splitSkillId(id);
  const tmp = `${out}.from-disk`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const yours = path.join(tmp, "yours");
    yoursAt(paths, source, original, entry.base, yours);
    const renames = new Map(
      (Object.entries(lock.skills) as [SkillId, SkillLock][])
        .filter(([other]) => splitSkillId(other).source === source)
        .map(([other, s]) => [splitSkillId(other).original as string, s.name]),
    );
    const renderOf = (from: string, to: string) => render({ from, to, source, original, name: entry.name, renames });
    const want = treeHash(dest);
    const rendersBack = (candidate: string) => {
      const check = `${candidate}.check`;
      renderOf(candidate, check);
      return treeHash(check) === want;
    };

    const reversed = path.join(tmp, "reversed");
    unrender(dest, yours, reversed, renames);
    if (rendersBack(reversed)) return void fs.cpSync(reversed, out, { recursive: true });

    const wrote = path.join(tmp, "wrote");
    renderOf(yours, wrote);
    const merged = path.join(tmp, "merged");
    const conflicts = mergeTrees(wrote, dest, yours, merged);
    if (!conflicts.length && rendersBack(merged)) return void fs.cpSync(merged, out, { recursive: true });
    throw new Error(
      `Could not turn the edits to ${entry.name} into a patch: they touch lines skl rewrites (the name, or a reference to another skill).\n  Save your copy, run skl sync --discard-edits, make the change again without touching those lines, then run skl edit ${id} --from-disk.`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** `dest` with skl's rewrites reversed into `out`; `yours` (unrendered) supplies the name and metadata shape. */
function unrender(dest: string, yours: string, out: string, renames: ReadonlyMap<string, string>): void {
  fs.cpSync(dest, out, { recursive: true });
  const back = new Map([...renames].map(([o, n]) => [n, o]));
  for (const file of markdownFiles(out)) {
    const r = rewriteReferences(fs.readFileSync(file, "utf8"), back);
    if (r.changes.length) fs.writeFileSync(file, r.text);
  }
  const skillMd = path.join(out, "SKILL.md");
  const theirs = fs.readFileSync(path.join(yours, "SKILL.md"), "utf8");
  const name = readFrontmatterName(theirs).name;
  let text = fs.readFileSync(skillMd, "utf8");
  if (name) text = setFrontmatterName(text, name);
  const lines = text.split("\n");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  const kept = lines.filter((l, i) => !(i < end && /^\s+skl-(source|original):/.test(l)));
  // render adds a metadata block when there was none, and turns `metadata: {}` into one.
  const at = kept.findIndex((l, i) => i > 0 && i < end && l === "metadata:");
  const empty = at >= 0 && !/^\s+\S/.test(kept[at + 1] ?? "");
  const had = /^metadata:(.*)$/m.exec(theirs.split(/^---$/m)[1] ?? "");
  if (empty && !had) kept.splice(at, 1);
  else if (empty && had?.[1].trim() === "{}") kept[at] = had[0];
  fs.writeFileSync(skillMd, kept.join("\n"));
}
