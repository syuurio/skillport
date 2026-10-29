import fs from "node:fs";
import path from "node:path";
import { fetchSource } from "./adapters/index.ts";
import { hasSecret, storeSecret, storeSecretValue } from "./keychain.ts";
import type { Lock } from "./lock.ts";
import { type Manifest, type SkillName, type Source, type SourceId, parseManifest, writeManifest } from "./manifest.ts";
import { chooseMany, isInteractive } from "./prompt.ts";
import type { Paths } from "./paths.ts";
import { describeSync, sync } from "./sync.ts";
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
  /** Fetch and print what would be installed; write no skill, manifest or token. */
  dryRun?: boolean;
  /** The command line you ran, repeated in the fix for a name clash. */
  command?: string;
}

/** `w` as you would type it in a shell. */
const shellWord = (w: string) => (/^[\w@%+=:,./~-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`);

/** `w` as splitCommand reads it back: quoted only when it has a space or a quote. */
const commandWord = (w: string) => (!/[\s'"]/.test(w) ? w : w.includes('"') ? `'${w}'` : `"${w}"`);

/**
 * The `skl add` you ran, to repeat in a fix. An installer command shows as
 * stored, with `{secret}` where its token was, so the token is never printed.
 */
export function addCommandLine(args: readonly string[], source: Source): string {
  const shown = args.map((w, i) => (args[i - 1] === "--installer" && source.type === "installer" ? source.command.map(commandWord).join(" ") : w));
  return ["skl", "add", ...shown].map(shellWord).join(" ");
}

export async function addSource(paths: Paths, manifest: Manifest, lock: Lock, id: string, source: Source, opts: AddOptions): Promise<string[]> {
  if (manifest.sources[id as SourceId]) throw new Error(`sources.${id} already exists; to install it again: skl update ${id}`);
  const next = parseManifest({ ...manifest, sources: { ...manifest.sources, [id]: source } }, paths.manifest);
  const sid = id as SourceId;
  const entry = next.sources[sid];

  if (entry.type === "installer" && entry.secret === "keychain" && !opts.dryRun) {
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
    const lines = describeSync(sync(paths, next, lock, { fetched: new Map([[sid, fetched]]), offeredNow: !opts.yes && isInteractive(), dryRun: opts.dryRun, adding: { id: sid, command: opts.command } }));
    if (!opts.dryRun) writeManifest(paths.manifest, next);
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

/** A command line split into words the way a shell would, quotes included. */
function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in command.");
  if (started) out.push(cur);
  return out;
}
