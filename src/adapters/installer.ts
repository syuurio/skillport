import fs from "node:fs";
import { runInstaller } from "../acquire.ts";
import type { InstallerSource, SourceId } from "../manifest.ts";
import { treeHash } from "../treehash.ts";
import { isPinnedSpec } from "../validate.ts";
import { type FetchOptions, type Fetched, skillsIn } from "./index.ts";

/** Run the installer in a fake HOME and take only what it left in `harvest`. */
export function fetchInstaller(id: SourceId, source: InstallerSource, opts: FetchOptions): Fetched {
  fs.rmSync(opts.staging, { recursive: true, force: true });
  fs.mkdirSync(opts.staging, { recursive: true, mode: 0o700 });
  const out = runInstaller(id, source, opts.staging, { interactive: opts.interactive, secret: opts.secret });
  // An installer pinned to a version is that version; otherwise only what it
  // produced identifies it.
  return { resolved: source.command.find(isPinnedSpec) ?? treeHash(out), skills: skillsIn(out) };
}
