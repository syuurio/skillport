import fs from "node:fs";
import path from "node:path";
import { type AddKind, addSource, buildSource } from "./add.ts";
import { adopt } from "./adopt.ts";
import { acquireLock } from "./apply.ts";
import { check as checkSources, realNet } from "./check.ts";
import { diff as diffSkill } from "./diff.ts";
import { type Kind, diagnose } from "./doctor.ts";
import { type EditMode, edit, runEditor } from "./edit.ts";
import { storeSecret } from "./keychain.ts";
import { readLock } from "./lock.ts";
import { type SourceId, readManifest } from "./manifest.ts";
import { migrate, v1Files } from "./migrate.ts";
import { type Paths, defaultPaths, withLinkTargets } from "./paths.ts";
import { Cancelled, ask, chooseMany, confirm, isInteractive } from "./prompt.ts";
import { removeSource } from "./remove.ts";
import { describeSchedule, news, notify, parseTime, realLaunchd, schedule } from "./schedule.ts";
import { count, home } from "./report.ts";
import { formatStatus, readStatus, which, writeStatus } from "./status.ts";
import { describeSync, neverFetched, sync } from "./sync.ts";
import { type UpdateIO, fetchSources, update } from "./update.ts";

const USAGE = `skl: one place for the agent skills that vendor installers scatter

  skl                              The TUI on a terminal, the status table otherwise
  skl add <id> (--github <owner/repo> | --installer "<command>" [--unattended "<args>"] | --npm <pkg@ver> --path <dir> | --local <dir>)
           [--prefix <p> | --no-prefix] [-y]   Add a source and install its skills
  skl sync [--discard-edits]       Make ~/.agents/skills match the manifest and lock (offline)
                                   skills you changed in place are kept unless --discard-edits
  skl check [source...] [--notify]  Look for updates; changes no skill. --notify sends a
                                   notification for updates it has not told you about yet
  skl status                       What check last found (offline)
  skl update [source...] [-i] [--pick] [--discard-edits]
                                   Show the plan, then apply it; -i runs an installer with you
                                   at the terminal, --pick chooses skills again
  skl which <name>                 The source, original name and version of an installed skill
  skl diff <source>[/<skill>] [-i]  What the next update would change, rewrites and patches included
  skl edit <source>/<skill> [--drop | --from-disk]
                                   Customize a skill as a patch kept across updates;
                                   --from-disk turns edits made in ~/.agents/skills into one
  skl adopt <owner/repo> [--as <id>] [-y]   Take over skills you installed with npx skills
  skl remove <source> [-y] [--discard-edits]   Remove a source's skills (to trash) and the source
  skl secret <source>              Store a source's token in Keychain
  skl doctor [--fix] [-y]          Stray copies, broken or missing links, edits, patches without a note
  skl schedule [daily [--at 09:00] | off]   Run skl check --notify every day (macOS launchd)
  skl migrate [--dry-run] [-y] [--discard-edits]   Move a skillport v1 setup to this version

Flags: --dry-run prints the plan only.  -y skips confirmations.
Manifest: ${home(defaultPaths().manifest)}`;

interface Flags {
  yes: boolean;
  interactive: boolean;
  pick: boolean;
  dryRun: boolean;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags: Flags = {
    yes: rest.includes("-y") || rest.includes("--yes"),
    interactive: rest.includes("-i"),
    pick: rest.includes("--pick"),
    dryRun: rest.includes("--dry-run"),
  };
  const args = rest.filter((a) => !a.startsWith("-"));
  const base = defaultPaths();
  const hasManifest = fs.existsSync(base.manifest);
  if ((!cmd || cmd === "status") && !hasManifest && fs.existsSync(v1Files(base).registry)) {
    console.log(`Found a skillport v1 setup in ${home(v1Files(base).registry)}. See what moving it over would do: skl migrate --dry-run`);
    return 0;
  }
  if (!cmd && hasManifest) {
    if (!isInteractive()) return statusCmd(base);
    // Loaded on demand: React and Ink cost every other command startup time.
    const { runTui } = await import("./tui/app.ts");
    await runTui(base);
    return 0;
  }
  switch (cmd) {
    case "add":
      return addCmd(base, rest);
    case "sync":
      return syncCmd(base, rest.includes("--discard-edits"));
    case "check":
      return checkCmd(base, args, rest.includes("--notify"));
    case "status":
      return statusCmd(base);
    case "update":
      return updateCmd(base, args, rest, flags);
    case "which":
      return whichCmd(base, args[0]);
    case "diff":
      return diffCmd(base, args[0], flags);
    case "edit":
      return editCmd(base, args[0], rest);
    case "adopt":
      return adoptCmd(base, args[0], rest);
    case "remove":
      return removeCmd(base, args[0], rest, flags);
    case "secret":
      return secretCmd(base, args[0]);
    case "doctor":
      return doctorCmd(base, rest.includes("--fix"), flags);
    case "migrate":
      return migrateCmd(base, rest, flags);
    case "schedule":
      return scheduleCmd(base, args[0], rest);
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

const KINDS: AddKind[] = ["github", "installer", "npm", "local"];

function scheduleCmd(base: Paths, mode: string | undefined, rest: string[]): number {
  if (mode === undefined) {
    console.log(describeSchedule(base, realLaunchd));
    return 0;
  }
  if (mode !== "daily" && mode !== "off") throw new Error("Usage: skl schedule [daily [--at 09:00] | off]");
  const job = { node: process.execPath, cli: import.meta.filename, pathEnv: process.env.PATH ?? "/usr/bin:/bin", ...parseTime(option(rest, "--at") ?? "09:00") };
  console.log(schedule(base, mode, job, realLaunchd).join("\n"));
  return 0;
}

function secretCmd(base: Paths, id: string | undefined): number {
  const manifest = readManifest(base.manifest);
  const source = manifest.sources[id as SourceId];
  if (!source) throw new Error(`Unknown source ${id}. Known: ${Object.keys(manifest.sources).join(", ")}`);
  if (source.type !== "installer" || source.secret !== "keychain") throw new Error(`sources.${id} does not use a token`);
  storeSecret(id as string);
  console.log(`Stored the token for sources.${id} in Keychain.`);
  return 0;
}

/**
 * doctor --fix does only what needs no judgement, like every other command
 * that changes files: --dry-run stops at the plan, a terminal confirms, -y
 * without one.
 */
async function doctorCmd(base: Paths, fix: boolean, flags: Flags): Promise<number> {
  const { manifest, paths, lock } = load(base);
  if (fix) cleanups.add(acquireLock(paths.sklDir));
  const findings = diagnose(paths, manifest, lock);
  if (!findings.length) {
    console.log("No problems found.");
    return 0;
  }
  const order: Kind[] = ["missing", "stray-copy", "broken-link", "missing-link", "edited", "no-note", "unowned"];
  for (const kind of order) {
    const ofKind = findings.filter((f) => f.kind === kind);
    if (!ofKind.length) continue;
    console.log(`\n${kind}`);
    for (const f of ofKind) console.log(`  ${f.fix ? "•" : "!"} ${f.message}`);
  }
  const fixable = findings.filter((f) => f.fix);
  if (!fix) {
    if (fixable.length) console.log(`\n${count(fixable.length, "problem")} marked • can be fixed safely: skl doctor --fix (removed copies go to trash)`);
    return findings.some((f) => !f.fix) ? 1 : 0;
  }
  if (!fixable.length) return 1;
  console.log(`\nPlan: fix the ${count(fixable.length, "problem")} marked •; moved copies go to ${home(path.join(paths.sklDir, "trash"))}.`);
  if (flags.dryRun) {
    console.log("dry run: nothing changed.");
    return 0;
  }
  if (!flags.yes) {
    if (!isInteractive()) throw new Error("No terminal to confirm on; pass -y to apply, or --dry-run to only see the plan.");
    if (!(await confirm("Fix them?"))) return 0;
  }
  for (const f of fixable) {
    f.fix!();
    console.log(`  ✓ ${f.message}`);
  }
  return findings.some((f) => !f.fix) ? 1 : 0;
}

const cleanups = new Set<() => void>();
process.on("exit", () => cleanups.forEach((f) => f()));
process.on("SIGINT", () => process.exit(130));
// A closed terminal or a kill should clean up too.
process.on("SIGHUP", () => process.exit(129));
process.on("SIGTERM", () => process.exit(143));

function option(rest: string[], flag: string): string | undefined {
  const at = rest.indexOf(flag);
  if (at < 0) return undefined;
  const value = rest[at + 1];
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

async function addCmd(base: Paths, rest: string[]): Promise<number> {
  const id = rest[0];
  if (!id || id.startsWith("-")) throw new Error(USAGE);
  const kinds = KINDS.filter((k) => rest.includes(`--${k}`));
  if (kinds.length > 1) throw new Error(`Pick one of --${kinds.join(", --")}`);
  const kind = kinds[0];
  const prefix = rest.includes("--no-prefix") ? false : option(rest, "--prefix");
  const { source, token } = buildSource({
    kind,
    value: option(rest, `--${kind}`) as string,
    path: option(rest, "--path"),
    unattended: option(rest, "--unattended"),
    prefix,
  });
  const manifest = readManifest(base.manifest);
  const paths = withLinkTargets(base, manifest, base.manifest);
  cleanups.add(acquireLock(paths.sklDir));
  // A flag's value is not a flag: --unattended "-y" does not mean -y.
  const valueFlags = ["--github", "--installer", "--npm", "--local", "--path", "--unattended", "--prefix"];
  const own = rest.filter((w, i) => !valueFlags.includes(rest[i - 1]));
  const yes = own.includes("-y") || own.includes("--yes");
  const lines = await addSource(paths, manifest, readLock(paths.lockFile), id, source, { yes, token });
  console.log(lines.length ? lines.join("\n") : "Nothing installed.");
  if (lines.length) console.log(`Added sources.${id} to ${home(paths.manifest)}`);
  return 0;
}

async function adoptCmd(base: Paths, from: string, rest: string[]): Promise<number> {
  const manifest = readManifest(base.manifest);
  const paths = withLinkTargets(base, manifest, base.manifest);
  cleanups.add(acquireLock(paths.sklDir));
  const yes = rest.includes("-y") || rest.includes("--yes");
  const lines = await adopt(paths, manifest, readLock(paths.lockFile), from, { id: option(rest, "--as"), yes });
  console.log(lines.join("\n"));
  return 0;
}

/** The manifest, the paths with its link targets, and the lock: what every command starts from. */
function load(base: Paths) {
  const manifest = readManifest(base.manifest);
  const paths = withLinkTargets(base, manifest, base.manifest);
  return { manifest, paths, lock: readLock(paths.lockFile) };
}

function checkCmd(base: Paths, ids: string[], notifyNews: boolean): number {
  const { manifest, paths, lock } = load(base);
  cleanups.add(acquireLock(paths.sklDir));
  const staging = path.join(paths.sklDir, "check");
  cleanups.add(() => fs.rmSync(staging, { recursive: true, force: true }));
  const result = checkSources(paths, manifest, lock, readStatus(paths.statusFile), ids, realNet(staging));
  writeStatus(paths.statusFile, result);
  console.log(formatStatus(manifest, lock, result));
  if (notifyNews) {
    const body = news(paths, manifest, result);
    if (body) notify(body);
    console.log(body ? `\nNotified:\n${body}` : "\nNothing new to notify.");
  }
  for (const [id, s] of Object.entries(result.sources)) {
    if (s.state === "updates" && s.link && (!ids.length || ids.includes(id))) console.log(`\n${id}: ${s.link}`);
  }
  return 0;
}

async function updateCmd(base: Paths, ids: string[], rest: string[], flags: Flags): Promise<number> {
  const { manifest, paths, lock } = load(base);
  cleanups.add(acquireLock(paths.sklDir));
  // Vendor content and installer HOMEs live here until the run ends.
  cleanups.add(() => fs.rmSync(path.join(paths.sklDir, "fetch"), { recursive: true, force: true }));
  const io: UpdateIO = {
    canAsk: isInteractive(),
    confirm: (q) => confirm(q, false),
    chooseMany: (q, options, initial) => chooseMany(q, options.map((o) => ({ value: o, label: o })), initial),
    print: (line) => console.log(line),
  };
  const updateFlags = { ...flags, pick: Boolean(flags.pick), discardEdits: rest.includes("--discard-edits") };
  return update(paths, manifest, lock, readStatus(paths.statusFile), ids, updateFlags, io);
}

function statusCmd(base: Paths): number {
  const { manifest, paths, lock } = load(base);
  console.log(formatStatus(manifest, lock, readStatus(paths.statusFile)));
  return 0;
}

function whichCmd(base: Paths, name: string | undefined): number {
  if (!name) throw new Error("Usage: skl which <installed name>");
  const { manifest, paths, lock } = load(base);
  console.log(which(paths, manifest, lock, name));
  return 0;
}

function diffCmd(base: Paths, target: string | undefined, flags: Flags): number {
  const { manifest, paths, lock } = load(base);
  cleanups.add(acquireLock(paths.sklDir));
  cleanups.add(() => fs.rmSync(path.join(paths.sklDir, "fetch"), { recursive: true, force: true }));
  const sid = target?.split("/")[0] as SourceId;
  if (!manifest.sources[sid]) throw new Error(`Usage: skl diff <source>[/<skill>]. Known sources: ${Object.keys(manifest.sources).join(", ")}`);
  const { fetched } = fetchSources(paths, manifest, [sid], flags.interactive, (line) => console.log(line));
  console.log(diffSkill(paths, manifest, lock, target, fetched).join("\n"));
  return 0;
}

async function removeCmd(base: Paths, id: string | undefined, rest: string[], flags: Flags): Promise<number> {
  const { manifest, paths, lock } = load(base);
  cleanups.add(acquireLock(paths.sklDir));
  const lines = await removeSource(paths, manifest, lock, id, {
    yes: flags.yes,
    discardEdits: rest.includes("--discard-edits"),
    confirm: isInteractive() ? (q) => confirm(q, false) : null,
  });
  console.log(lines.join("\n"));
  return 0;
}

async function editCmd(base: Paths, arg: string | undefined, rest: string[]): Promise<number> {
  const { manifest, paths, lock } = load(base);
  cleanups.add(acquireLock(paths.sklDir));
  const mode: EditMode = rest.includes("--drop") ? "drop" : rest.includes("--from-disk") ? "from-disk" : "edit";
  const io = {
    editor: runEditor,
    askNote: () => (isInteractive() ? ask("Why this change? (saved as the note; enter to skip)") : Promise.resolve("")),
  };
  console.log((await edit(paths, manifest, lock, arg, mode, io)).join("\n"));
  return 0;
}

async function migrateCmd(base: Paths, rest: string[], flags: Flags): Promise<number> {
  // A dry run writes nothing, not even skl's own folder.
  if (!flags.dryRun) {
    cleanups.add(acquireLock(base.sklDir));
    cleanups.add(() => fs.rmSync(path.join(base.sklDir, "fetch"), { recursive: true, force: true }));
  }
  const print = (line: string) => console.log(line);
  return migrate(base, {
    dryRun: flags.dryRun,
    yes: flags.yes,
    discardEdits: rest.includes("--discard-edits"),
    confirm: isInteractive() ? (q) => confirm(q, false) : null,
    print,
    fetch: (manifest, paths) => fetchSources(paths, manifest, Object.keys(manifest.sources) as SourceId[], false, print),
  });
}

function syncCmd(base: Paths, discardEdits: boolean): number {
  const manifest = readManifest(base.manifest);
  const paths = withLinkTargets(base, manifest, base.manifest);
  cleanups.add(acquireLock(paths.sklDir));
  const lock = readLock(paths.lockFile);
  const lines = describeSync(sync(paths, manifest, lock, { discardEdits }));
  // sync never goes online, so a source it has never fetched stays missing.
  const missing = neverFetched(manifest, lock);
  if (missing.length) lines.push(`not installed yet (sync works offline): ${missing.join(", ")}. Fetch them with: skl update ${missing.join(" ")}`);
  console.log(lines.length ? lines.join("\n") : "up to date");
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Cancelled)) console.error((e as Error).message);
  process.exitCode = e instanceof Cancelled ? 130 : 1;
}
