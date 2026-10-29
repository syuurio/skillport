import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type SourceId, parseManifest } from "../src/manifest.ts";
import { defaultPaths } from "../src/paths.ts";
import { type Launchd, describeSchedule, label, news, parseTime, plist, plistPath, schedule } from "../src/schedule.ts";
import type { SourceStatus, Status } from "../src/status.ts";

const sandbox = () => defaultPaths(fs.mkdtempSync(path.join(os.tmpdir(), "skl-sched-")));
const job = { program: "/src/skl & co/bin/skillport", pathEnv: "/opt/node/bin:/usr/bin", hour: 9, minute: 5 };

function fakeLaunchd() {
  const loaded = new Set<string>();
  const calls: string[] = [];
  const launchd: Launchd = {
    bootstrap: (file) => {
      calls.push(`bootstrap ${path.basename(file)}`);
      loaded.add(path.basename(file, ".plist"));
    },
    bootout: (id) => {
      calls.push(`bootout ${id}`);
      loaded.delete(id);
    },
    loaded: (id) => loaded.has(id),
  };
  return { launchd, calls };
}

test("a sandbox HOME gets its own job, so it never replaces your real schedule", () => {
  assert.equal(label(defaultPaths(os.homedir())), "com.skillport.check");
  const paths = sandbox();
  assert.match(label(paths), /^com\.skillport\.check\.[0-9a-f]{8}$/);
  assert.equal(plistPath(paths), path.join(paths.home, "Library", "LaunchAgents", `${label(paths)}.plist`));
});

test("the job runs skl check --notify through skl's launcher, with your PATH and the sandbox HOME", () => {
  const paths = sandbox();
  const file = path.join(paths.home, "job.plist");
  fs.writeFileSync(file, plist(paths, job));
  assert.equal(spawnSync("plutil", ["-lint", file]).status, 0);
  const parsed = JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout);
  assert.deepEqual(parsed.ProgramArguments, ["/src/skl & co/bin/skillport", "check", "--notify"]);
  assert.deepEqual(parsed.EnvironmentVariables, { PATH: "/opt/node/bin:/usr/bin", SKILLPORT_HOME: paths.home });
  assert.deepEqual(parsed.StartCalendarInterval, { Hour: 9, Minute: 5 });
  assert.equal(parsed.StandardOutPath, path.join(paths.sklDir, "schedule.log"));
});

test("schedule daily loads the job, again replaces it, and off removes it", () => {
  const paths = sandbox();
  const { launchd, calls } = fakeLaunchd();
  const id = label(paths);
  assert.match(describeSchedule(paths, launchd), /No daily check is scheduled/);
  assert.match(schedule(paths, "daily", job, launchd).join("\n"), /every day at 09:05[\s\S]*skl schedule off/);
  assert.ok(fs.existsSync(plistPath(paths)));
  assert.match(describeSchedule(paths, launchd), /runs every day at 09:05/);
  schedule(paths, "daily", { ...job, hour: 21, minute: 0 }, launchd);
  assert.deepEqual(calls, [`bootstrap ${id}.plist`, `bootout ${id}`, `bootstrap ${id}.plist`]);
  assert.match(describeSchedule(paths, launchd), /runs every day at 21:00/);
  assert.deepEqual(schedule(paths, "off", job, launchd), ["Stopped the daily check."]);
  assert.ok(!fs.existsSync(plistPath(paths)) && !launchd.loaded(id));
  assert.deepEqual(schedule(paths, "off", job, launchd), ["No daily check was scheduled."]);
});

test("--at takes a 24-hour time", () => {
  assert.deepEqual(parseTime("7:30"), { hour: 7, minute: 30 });
  assert.deepEqual(parseTime("23:59"), { hour: 23, minute: 59 });
  for (const bad of ["24:00", "9", "09:60", "9am"]) assert.throws(() => parseTime(bad), /--at takes a time like 09:00/);
});

const manifest = parseManifest(
  {
    version: 2,
    sources: {
      matt: { type: "github", repo: "mattpocock/skills" },
      motion: { type: "npm", package: "motion-ai@14.2.0", path: "content/skills" },
      emil: { type: "installer", command: ["npx", "-y", "@emil/install@1.0.0"], unattended: [] },
    },
  },
  "manifest.json",
);
const at = "2026-10-29T09:00:00.000Z";
type Found = SourceStatus extends infer S ? (S extends SourceStatus ? Omit<S, "checkedAt"> : never) : never;
const status = (sources: Record<string, Found>): Status => ({
  checkedAt: at,
  sources: Object.fromEntries(Object.entries(sources).map(([id, s]) => [id, { checkedAt: at, ...s }])) as Record<SourceId, SourceStatus>,
  skills: {},
});

test("each update is told once; a newer one, or one that comes back, is told again", () => {
  const paths = sandbox();
  const matt = { state: "updates" as const, from: "4f2a91c", to: "b81e0d3", changed: ["tdd", "grill"], added: [] as string[], removed: [] as string[] };
  const first = status({ matt, motion: { state: "pinned-behind", current: "14.2.0", latest: "14.3.0" }, emil: { state: "up-to-date", pinned: "1.0.0" } });
  assert.equal(news(paths, manifest, first), "matt: 2 updates\nmotion: 14.3.0 available (pinned 14.2.0)");
  assert.equal(news(paths, manifest, first), null);
  // Only what changed since the last notification is in the next one.
  const newer = status({ matt: { ...matt, to: "c0ffee1" }, motion: { state: "pinned-behind", current: "14.2.0", latest: "14.3.0" } });
  assert.equal(news(paths, manifest, newer), "matt: 2 updates");
  assert.equal(news(paths, manifest, status({ matt: { ...matt, to: "c0ffee1", added: ["deploy"] } })), "matt: 2 updates · 1 new");
  // Applied, then the same version shows up again later: that is news again.
  assert.equal(news(paths, manifest, status({ matt: { state: "up-to-date" } })), null);
  assert.equal(news(paths, manifest, status({ motion: { state: "pinned-behind", current: "14.2.0", latest: "14.3.0" } })), "motion: 14.3.0 available (pinned 14.2.0)");
});

test("errors, unknowns and missing tokens are not notifications", () => {
  const paths = sandbox();
  const quiet = status({
    matt: { state: "unknown", reason: "GitHub unreachable" },
    motion: { state: "error", reason: "boom" },
    emil: { state: "needs-token" },
  });
  assert.equal(news(paths, manifest, quiet), null);
});
