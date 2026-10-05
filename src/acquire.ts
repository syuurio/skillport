import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSecret } from "./keychain.ts";
import type { InstallerSet, ManagedSet, NpmSet } from "./registry.ts";

const INSTALLER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Environment for every npm/npx child. npm writes each run's full argv,
 * including `--token=...`, to a debug log; `logs-max=0` turns that off and
 * `logs-dir` keeps any log inside staging, which is deleted after the run.
 * The package cache stays shared so npx does not re-download every time.
 */
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
  fs.mkdirSync(staging, { recursive: true });
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
    const why = r.signal === "SIGTERM" ? "timed out" : `exited ${r.status}`;
    const hint = opts.interactive
      ? ""
      : `\nIf the installer needs answers, run it interactively: skl update ${id} -i`;
    throw new Error(`Installer for "${id}" ${why}.\n${output}${hint}`);
  }
  const out = path.join(fakeHome, set.harvest ?? ".claude/skills");
  if (!fs.existsSync(out)) {
    throw new Error(`Installer for "${id}" wrote nothing to ${set.harvest ?? ".claude/skills"}.\n${output}`);
  }
  return out;
}

function extractNpm(set: NpmSet, staging: string): string {
  // cwd inside staging so a project .npmrc in wherever `skl` was started
  // cannot redirect the registry.
  const pack = spawnSync("npm", ["pack", set.package, "--silent", "--pack-destination", staging], {
    cwd: staging,
    encoding: "utf8",
    env: { ...process.env, ...npmEnv(staging) },
  });
  if (pack.status !== 0) throw new Error(`npm pack ${set.package} failed.\n${pack.stderr}`);
  const tgz = path.join(staging, pack.stdout.trim().split("\n").at(-1)!);
  const tar = spawnSync("tar", ["xzf", tgz, "-C", staging], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar failed.\n${tar.stderr}`);
  return path.join(staging, "package", set.path);
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
  const spec = set.type === "npm" ? set.package : set.command.find((a) => /^@?[^-][^@]*@\d/.test(a));
  const m = spec ? /^(@?[^@]+)@(.+)$/.exec(spec) : null;
  return m ? { name: m[1], version: m[2] } : null;
}

export function latestVersion(name: string, staging: string): string | null {
  const r = spawnSync("npm", ["view", name, "version"], {
    cwd: staging,
    encoding: "utf8",
    env: { ...process.env, ...npmEnv(staging) },
  });
  return r.status === 0 ? r.stdout.trim() : null;
}
