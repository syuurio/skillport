import fs from "node:fs";
import { extractNpm } from "../acquire.ts";
import type { NpmSource } from "../manifest.ts";
import { type FetchOptions, type Fetched, skillsIn } from "./index.ts";

/** `npm pack` the pinned package; nothing in it runs. */
export function fetchNpm(source: NpmSource, opts: FetchOptions): Fetched {
  fs.rmSync(opts.staging, { recursive: true, force: true });
  fs.mkdirSync(opts.staging, { recursive: true, mode: 0o700 });
  return { resolved: source.package, skills: skillsIn(extractNpm(source, opts.staging)) };
}
