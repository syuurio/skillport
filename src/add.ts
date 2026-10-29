import fs from "node:fs";
import path from "node:path";
import { fetchSource } from "./adapters/index.ts";
import { hasSecret, storeSecret, storeSecretValue } from "./keychain.ts";
import type { Lock } from "./lock.ts";
import { type Manifest, type SkillName, type Source, type SourceId, parseManifest, writeManifest } from "./manifest.ts";
import { chooseMany, isInteractive } from "./prompt.ts";
import type { Paths } from "./registry.ts";
import { splitCommand } from "./register.ts";
import { sync } from "./sync.ts";
import { extractSecret, usesSecret } from "./validate.ts";

// `skl add`: one new source, from flags to installed skills. The manifest is
// written last, so a failed fetch or a collision leaves it as it was.

export type AddKind = "github" | "installer" | "npm" | "local";

export interface AddFlags {
  kind: AddKind;
  /** The repo, command line, package spec or folder. */
  value: string;
  /** npm: the skill folder inside the package. */
  path?: string;
  /** installer: extra args for an unattended run, as one line. */
  unattended?: string;
  prefix?: string | false;
}

/**
 * The manifest entry for the flags. A token typed into the command is taken
 * out and returned separately, so it reaches Keychain and never the manifest.
 */
export function buildSource(flags: AddFlags, cwd = process.cwd()): { source: Source; token?: string } {
  const prefix = flags.prefix === undefined ? {} : { prefix: flags.prefix };
  switch (flags.kind) {
    case "github":
      return { source: { type: "github", repo: flags.value, ...prefix } };
    case "npm":
      return { source: { type: "npm", package: flags.value, path: flags.path ?? "", ...prefix } };
    case "local":
      return { source: { type: "local", path: flags.value.startsWith("~/") ? flags.value : path.resolve(cwd, flags.value), ...prefix } };
    case "installer": {
      const { command, secret: token } = extractSecret(splitCommand(flags.value));
      const unattended = flags.unattended === undefined ? undefined : splitCommand(flags.unattended);
      const run = { command, ...(unattended ? { unattended } : {}) };
      const secret = usesSecret(run) ? { secret: "keychain" as const } : {};
      return { source: { type: "installer", ...run, ...secret, ...prefix }, token };
    }
  }
}

export interface AddOptions {
  /** Install every skill without asking. */
  yes: boolean;
  token?: string;
}

export async function addSource(paths: Paths, manifest: Manifest, lock: Lock, id: string, source: Source, opts: AddOptions): Promise<string[]> {
  if (manifest.sources[id as SourceId]) throw new Error(`sources.${id} already exists; to install it again: skl update ${id}`);
  const next = parseManifest({ ...manifest, sources: { ...manifest.sources, [id]: source } }, paths.manifest);
  const sid = id as SourceId;
  const entry = next.sources[sid];

  if (entry.type === "installer" && entry.secret === "keychain") {
    if (opts.token) storeSecretValue(id, opts.token);
    else if (!hasSecret(id)) {
      if (!isInteractive()) throw new Error(`sources.${id} needs a token. Store it first: skl secret ${id}`);
      storeSecret(id);
    }
  }
  // Without unattended args the installer can only run with you answering it.
  const interactive = entry.type === "installer" && entry.unattended === undefined;
  if (interactive && !isInteractive()) throw new Error(`sources.${id} has no --unattended args, so its installer needs a terminal`);

  const staging = path.join(paths.sklDir, "fetch", id);
  try {
    const fetched = fetchSource(sid, entry, { staging, interactive, home: paths.home, sklDir: paths.sklDir });
    if (!fetched.skills.length) throw new Error(`sources.${id} has no skills (no folder with a SKILL.md)`);
    const all = fetched.skills.map((s) => s.original);
    const picked = opts.yes || !isInteractive() ? all : await pick(id, all);
    if (!picked.length) return [];
    if (picked.length < all.length) entry.pick = picked;
    const lines = sync(paths, next, lock, { fetched: new Map([[sid, fetched]]) });
    writeManifest(paths.manifest, next);
    return lines;
  } finally {
    // The installer's fake HOME may hold the token it was given.
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function pick(id: string, all: SkillName[]): Promise<string[]> {
  return chooseMany(
    `Which skills from "${id}"? (space to toggle, a for all)`,
    all.map((n) => ({ value: n, label: n })),
    all,
  );
}
