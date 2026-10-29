import fs from "node:fs";
import path from "node:path";
import type { Lock } from "./lock.ts";
import { type Manifest, type SourceId, splitSkillId, writeManifest } from "./manifest.ts";
import type { Paths } from "./paths.ts";
import { home } from "./report.ts";
import { describeSync, sync } from "./sync.ts";

// `skl remove <source>`: its skills go to trash, its links go, and the
// manifest forgets it. Your patches and a Keychain token stay, so adding it
// again later picks them up.

export interface RemoveOptions {
  yes: boolean;
  discardEdits: boolean;
  /** Asks before removing; null without a terminal. */
  confirm: ((question: string) => Promise<boolean>) | null;
}

export async function removeSource(paths: Paths, manifest: Manifest, lock: Lock, id: string | undefined, opts: RemoveOptions): Promise<string[]> {
  if (!id) throw new Error("Usage: skl remove <source> [-y] [--discard-edits]");
  const sid = id as SourceId;
  const source = manifest.sources[sid];
  if (!source) throw new Error(`Unknown source ${id}. Known: ${Object.keys(manifest.sources).join(", ") || "(none)"}`);
  const next: Manifest = structuredClone(manifest);
  delete next.sources[sid];

  const plan = sync(paths, next, lock, { dryRun: true, discardEdits: opts.discardEdits }).filter((c) => splitSkillId(c.id).source === sid);
  const edited = plan.filter((c) => c.kind === "edited");
  if (edited.length) {
    const names = edited.map((c) => c.name).join(", ");
    throw new Error(`Nothing was changed: you edited ${names} in place.\n  keep the edits as a patch first: skl edit <source>/<skill> --from-disk\n  or remove anyway:                skl remove ${sid} --discard-edits`);
  }
  const removing = plan.filter((c) => c.kind === "remove").map((c) => c.name);
  const question = `Remove sources.${sid}${removing.length ? ` and its skills (${removing.join(", ")})` : ""}?`;
  if (!opts.yes) {
    if (!opts.confirm) throw new Error("skl remove needs -y without a terminal");
    if (!(await opts.confirm(question))) return ["Nothing was changed."];
  }

  const lines = describeSync(sync(paths, next, lock, { discardEdits: opts.discardEdits }));
  writeManifest(paths.manifest, next);
  // Regenerated on the next add: the shadow HOME and any merge in progress.
  fs.rmSync(path.join(paths.sklDir, "cli", sid), { recursive: true, force: true });
  fs.rmSync(path.join(paths.sklDir, "merge", sid), { recursive: true, force: true });
  lines.push(`Removed sources.${sid} from ${home(paths.manifest)}`);
  const patches = path.join(paths.patchesDir, sid);
  if (fs.existsSync(patches)) lines.push(`Kept your patches in ${home(patches)}; they apply again if you add ${sid} back.`);
  if (source.type === "installer" && source.secret === "keychain") lines.push(`Kept its Keychain token; to delete it: security delete-generic-password -s skillport -a ${sid}`);
  return lines;
}
