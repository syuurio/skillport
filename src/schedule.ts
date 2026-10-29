import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Manifest, SourceId } from "./manifest.ts";
import type { Paths } from "./paths.ts";
import { home } from "./report.ts";
import { type SourceStatus, type Status, describeState } from "./status.ts";

// `skl schedule`: a launchd agent that runs `skl check --notify` once a day,
// and the notification that check sends when something is new. The check
// itself only asks git, GitHub and npm; no installer runs in the background.

/** What launchd does for skl; replaced in tests so they never touch the real one. */
export interface Launchd {
  bootstrap(plist: string): void;
  bootout(label: string): void;
  loaded(label: string): boolean;
}

const domain = () => `gui/${process.getuid?.() ?? 0}`;

export const realLaunchd: Launchd = {
  bootstrap: (plist) => {
    const r = spawnSync("launchctl", ["bootstrap", domain(), plist], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}`);
  },
  bootout: (label) => {
    spawnSync("launchctl", ["bootout", `${domain()}/${label}`], { stdio: "ignore" });
  },
  loaded: (label) => spawnSync("launchctl", ["print", `${domain()}/${label}`], { stdio: "ignore" }).status === 0,
};

/** One job per HOME, so a SKILLPORT_HOME sandbox never replaces your real schedule. */
export function label(paths: Paths): string {
  if (paths.home === os.homedir()) return "com.skillport.check";
  return `com.skillport.check.${crypto.createHash("sha1").update(paths.home).digest("hex").slice(0, 8)}`;
}

export const plistPath = (paths: Paths) => path.join(paths.home, "Library", "LaunchAgents", `${label(paths)}.plist`);

export interface Job {
  /**
   * skl's own launcher, as an absolute path: launchd's PATH does not have it.
   * macOS lists a background job under the program it starts, so the job
   * starts this script, not node, to show up as "skillport".
   */
  program: string;
  /** PATH for the job, so node, git, gh and npm resolve as they do in your shell. */
  pathEnv: string;
  hour: number;
  minute: number;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(paths: Paths, job: Job): string {
  const env: Record<string, string> = { PATH: job.pathEnv };
  if (paths.home !== os.homedir()) env.SKILLPORT_HOME = paths.home;
  const log = path.join(paths.sklDir, "schedule.log");
  const str = (s: string) => `<string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(label(paths))}
  <key>ProgramArguments</key>
  <array>${[job.program, "check", "--notify"].map(str).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env)
    .map(([k, v]) => `<key>${k}</key>${str(v)}`)
    .join("")}</dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${job.hour}</integer><key>Minute</key><integer>${job.minute}</integer></dict>
  <key>StandardOutPath</key>${str(log)}
  <key>StandardErrorPath</key>${str(log)}
</dict>
</plist>
`;
}

/** `HH:MM` on a 24-hour clock. */
export function parseTime(at: string): { hour: number; minute: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!m) throw new Error(`--at takes a time like 09:00, not ${at}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function schedule(paths: Paths, mode: "daily" | "off", job: Job, launchd: Launchd): string[] {
  const id = label(paths);
  const file = plistPath(paths);
  if (launchd.loaded(id)) launchd.bootout(id);
  if (mode === "off") {
    const had = fs.existsSync(file);
    fs.rmSync(file, { force: true });
    return [had ? "Stopped the daily check." : "No daily check was scheduled."];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(paths.sklDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, plist(paths, job));
  launchd.bootstrap(file);
  const at = `${String(job.hour).padStart(2, "0")}:${String(job.minute).padStart(2, "0")}`;
  return [
    `skl check runs every day at ${at} and sends a notification when something is new.`,
    `  job: ${id} (${home(file)})`,
    `  log: ${home(path.join(paths.sklDir, "schedule.log"))}`,
    "Stop it with: skl schedule off",
  ];
}

export function describeSchedule(paths: Paths, launchd: Launchd): string {
  const file = plistPath(paths);
  if (!fs.existsSync(file)) return "No daily check is scheduled. Start one with: skl schedule daily [--at 09:00]";
  const m = /<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/.exec(fs.readFileSync(file, "utf8"));
  const at = m ? `${m[1].padStart(2, "0")}:${m[2].padStart(2, "0")}` : "a set time";
  return launchd.loaded(label(paths))
    ? `skl check runs every day at ${at}. Stop it with: skl schedule off`
    : `${home(file)} exists but is not loaded. Run skl schedule daily to load it again.`;
}

/** What identifies one batch of news for a source; a different key is news again. */
function newsKey(s: SourceStatus): string | null {
  if (s.state === "updates") return [s.to, ...s.added].join(" ");
  if (s.state === "pinned-behind") return s.latest;
  return null;
}

type Notified = Record<string, string>;

const notifiedFile = (paths: Paths) => path.join(paths.sklDir, "notified.json");

function readNotified(paths: Paths): Notified {
  try {
    return JSON.parse(fs.readFileSync(notifiedFile(paths), "utf8")) as Notified;
  } catch {
    return {};
  }
}

/**
 * The notification for what check found that was not announced before, or
 * null. Records what it announces, and forgets a source once it has no news,
 * so the same update is told once.
 */
export function news(paths: Paths, manifest: Manifest, status: Status): string | null {
  const before = readNotified(paths);
  const after: Notified = {};
  const fresh: string[] = [];
  for (const [id, s] of Object.entries(status.sources) as [SourceId, SourceStatus][]) {
    const source = manifest.sources[id];
    const key = source ? newsKey(s) : null;
    if (!key) continue;
    after[id] = key;
    if (before[id] !== key) fresh.push(`${id}: ${describeState(s, source.type)}`);
  }
  fs.mkdirSync(paths.sklDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(notifiedFile(paths), `${JSON.stringify(after, null, 2)}\n`);
  return fresh.length ? fresh.join("\n") : null;
}

/** A macOS notification; the text goes in as an argument, never as AppleScript. */
export function notify(body: string): void {
  spawnSync(
    "osascript",
    ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "skl" subtitle "Updates available: run skl"', "-e", "end run", body],
    { stdio: "ignore" },
  );
}
