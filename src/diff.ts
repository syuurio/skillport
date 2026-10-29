import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Fetched } from "./adapters/index.ts";
import type { Lock } from "./lock.ts";
import { type Manifest, type SourceId, splitSkillId } from "./manifest.ts";
import { diffTrees } from "./patch.ts";
import type { Paths } from "./registry.ts";
import { describeSync, sync } from "./sync.ts";

// `skl diff <source>[/<skill>]`: what the next update would do to the
// folders in ~/.agents/skills, rewrites and patches included. Writes no skill.

export function diff(paths: Paths, manifest: Manifest, lock: Lock, target: string | undefined, fetched: ReadonlyMap<SourceId, Fetched>): string[] {
  if (!target) throw new Error("Usage: skl diff <source>[/<skill>]");
  const [sid, original] = target.split("/") as [SourceId, string | undefined];
  if (!manifest.sources[sid]) throw new Error(`Unknown source ${sid}. Known: ${Object.keys(manifest.sources).join(", ")}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skl-diff-"));
  try {
    const next = path.join(tmp, "next");
    const changes = sync(paths, manifest, structuredClone(lock), { fetched, dryRun: true, keep: next }).filter((c) => {
      const id = splitSkillId(c.id);
      return id.source === sid && (!original || id.original === original);
    });
    if (!changes.length) return [original ? `${target}: no changes` : `${sid}: no changes`];
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    return changes.flatMap((c) => {
      const lines = describeSync([c]);
      if (c.kind !== "install") return lines;
      const now = path.join(paths.skillsDir, c.name);
      return [...lines, diffTrees(fs.existsSync(now) ? now : empty, path.join(next, c.name)).trimEnd()];
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
