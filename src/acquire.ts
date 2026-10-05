import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSecret } from "./keychain.ts";
import { isPackageName, isPinnedSpec } from "./validate.ts";
import type { InstallerSet, ManagedSet, NpmSet } from "./registry.ts";

const INSTALLER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The only variables a vendor process gets. Your shell environment often holds
 * API keys and tokens; an installer needs none of them, only a PATH to find
 * node/npx, locale and terminal settings, and proxy or CA settings to reach
 * its download server.
 */
const PASS_THROUGH = [
  "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];

export function sandboxEnv(home: string, staging: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return { ...env, HOME: home, ...npmEnv(staging) };
}

/**
 * Environment for every npm/npx child. npm writes each run's full argv,
 * including `--token=...`, to a debug log; `logs-max=0` turns that off and
 * `logs-dir` keeps any log inside staging, which is deleted after the run.
 * The package cache stays shared so npx does not re-download every time.
 */
export function npmEnv(staging: string): Record<string, string> {
  return {
    npm_config_cache: path.join(os.homedir(), ".npm"),
    npm_config_logs_dir: path.join(staging, "npm-logs"),
    npm_config_logs_max: "0",
  };
}

export interface AcquireOptions {
  /** Hand the real terminal to the installer so you answer its questions. */
  interactive: boolean;
}

/**
 * Produce a directory holding one folder per skill, exactly as the vendor
 * ships it. `staging` is emptied first and belongs to the caller.
 */
export function acquire(
  id: string,
  set: ManagedSet,
  staging: string,
  opts: AcquireOptions,
): string {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  return set.type === "installer"
    ? runInstaller(id, set, staging, opts)
    : extractNpm(set, staging);
}

function runInstaller(
  id: string,
  set: InstallerSet,
  staging: string,
  opts: AcquireOptions,
): string {
  const fakeHome = path.join(staging, "home");
  for (const d of set.stage ?? [".claude"]) {
    fs.mkdirSync(path.join(fakeHome, d), { recursive: true });
  }
  if (set.secret !== "keychain" && set.command.some((a) => a.includes("{secret}"))) {
    // Running it would pass an empty token; a registry typo, not a choice.
    throw new Error(`"${id}" uses {secret} in its command but has no "secret": "keychain".`);
  }
  const secret = set.secret === "keychain" ? readSecret(id) : "";
  const redact = (s: string) => (secret ? s.replaceAll(secret, "***") : s);
  // No vendor knowledge lives here: the scope flag is part of `command`, and
  // the non-interactive switch is whatever the registry says it is.
  if (!opts.interactive && set.unattended === undefined) {
    throw new Error(`"${id}" declares no \`unattended\` args, so it only runs interactively: skl update ${id} -i`);
  }
  const argv = [
    ...set.command.map((a) => a.replaceAll("{secret}", secret)),
    ...(opts.interactive ? [] : (set.unattended ?? [])),
  ];

  // Installers find agent folders through os.homedir(), which follows $HOME
  // on POSIX. cwd is inside the sandbox too, so a "project" install is caught.
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: fakeHome,
    encoding: "utf8",
    env: sandboxEnv(fakeHome, staging),
    // Unattended runs get no stdin: a prompt reads EOF and exits instead of
    // waiting forever.
    stdio: opts.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: opts.interactive ? undefined : INSTALLER_TIMEOUT_MS,
  });
  const output = redact(`${r.stdout ?? ""}${r.stderr ?? ""}`).trim();
  if (r.error || r.status !== 0) {
    if (!opts.interactive && (r.signal === "SIGTERM" || looksLikeAPrompt(output))) throw new NeedsInteraction(id, output);
    throw new Error(`Installer for "${id}" exited ${r.status ?? r.signal}.\n${output}`);
  }
  const out = path.join(fakeHome, set.harvest ?? ".claude/skills");
  // A prompt that read EOF often exits 0 after printing "cancelled",
  // leaving nothing (or an empty folder) behind.
  const empty = !fs.existsSync(out) || fs.readdirSync(out).length === 0;
  if (empty && !opts.interactive && (looksLikeAPrompt(output) || /cancel/i.test(output))) throw new NeedsInteraction(id, output);
  if (!fs.existsSync(out)) {
    throw new Error(`Installer for "${id}" wrote nothing to ${set.harvest ?? ".claude/skills"}.\n${output}`);
  }
  return out;
}

/** The installer stopped at a question it could not get an answer to. */
export class NeedsInteraction extends Error {
  constructor(id: string, output: string) {
    super(`The installer for "${id}" is waiting for answers. Run it with you at the terminal: skl update ${id} -i\n${output.split("\n").slice(-5).join("\n")}`);
  }
}

/**
 * Whether an unattended run's last lines read as a question: an interactive
 * prompt left hanging until the timeout, or one that got EOF on stdin.
 */
export function looksLikeAPrompt(output: string): boolean {
  const tail = output.split("\n").slice(-6).join("\n");
  return /\?\s*(\(y\/n\)|\[y\/n\]|›|$)|ok to proceed|press enter|select |choose |◆|❯/im.test(tail);
}

/**
 * `npm pack` a package spec into `dir` and unpack it; returns the package
 * root. Nothing in the package runs. cwd is `dir` so a project .npmrc in
 * wherever `skl` was started cannot redirect the registry.
 */
export function npmPack(spec: string, dir: string): string {
  // Only `name@1.2.3`: npm would also take git URLs and `owner/repo`, and for
  // git sources it runs the repo's prepare script. --ignore-scripts and the
  // minimal environment are the second line.
  if (!isPinnedSpec(spec)) throw new Error(`"${spec}" is not a registry package pinned to a version.`);
  const pack = spawnSync("npm", ["pack", spec, "--silent", "--ignore-scripts", "--pack-destination", dir], {
    cwd: dir,
    encoding: "utf8",
    env: sandboxEnv(os.homedir(), dir),
  });
  if (pack.status !== 0) throw new Error(`npm pack ${spec} failed.\n${pack.stderr}`);
  const tgz = path.join(dir, pack.stdout.trim().split("\n").at(-1)!);
  const tar = spawnSync("tar", ["xzf", tgz, "-C", dir], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar failed.\n${tar.stderr}`);
  return path.join(dir, "package");
}

function extractNpm(set: NpmSet, staging: string): string {
  return path.join(npmPack(set.package, staging), set.path);
}

export function listSkillDirs(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => path.join(root, e.name))
    .filter((d) => fs.existsSync(path.join(d, "SKILL.md")))
    .sort();
}

/** Package spec pinned in a set, e.g. `@aiforui/install@0.1.4`. */
export function pinnedPackage(set: ManagedSet): { name: string; version: string } | null {
  const spec = set.type === "npm" ? set.package : set.command.find(isPinnedSpec);
  const m = spec && isPinnedSpec(spec) ? /^(@?[^@]+)@(.+)$/.exec(spec) : null;
  return m ? { name: m[1], version: m[2] } : null;
}

export function latestVersion(name: string, staging: string): string | null {
  if (!isPackageName(name)) return null;
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const r = spawnSync("npm", ["view", name, "version"], {
    cwd: staging,
    encoding: "utf8",
    env: sandboxEnv(os.homedir(), staging),
  });
  return r.status === 0 ? r.stdout.trim() : null;
}
