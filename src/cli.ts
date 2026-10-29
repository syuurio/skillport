import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NeedsInteraction, acquire, compareVersions, latestVersion, pinnedPackage, publishTimes } from "./acquire.ts";
import { acquireLock, apply, removeManaged } from "./apply.ts";
import { hasSecret, storeSecret, storeSecretValue } from "./keychain.ts";
import { type Finding, type Kind, diagnose, diagnoseV2 } from "./doctor.ts";
import { type CliPlan, applyCli, applyCliLinks, cliLinkChanges, removeCliSkills, listSource, lockedFor, planCli, upstreamChanges } from "./skillscli.ts";
import { type Plan, plan } from "./plan.ts";
import { pluginSkillNames } from "./plugins.ts";
import { askForSet, validateSet } from "./register.ts";
import { Cancelled, ask, askSecret, chooseMany, confirm, intro, isInteractive, log, note, outro } from "./prompt.ts";
import {
  type ManagedSet,
  type Paths,
  type Registry,
  type Resolution,
  type SkillSet,
  type SkillsCliSet,
  defaultPaths,
  getSet,
  isManaged,
  linkDirsFor,
  prefixOf,
  readRegistry,
  withLinkTargets,
  runsUnattended,
  skillName,
  writeRegistry,
} from "./registry.ts";
import { readSkillLock, readState, writeState } from "./state.ts";
import { resolveCliCollision, resolveInteractively } from "./collide.ts";
import { type Ctx, type Flags, confirmChange, confirmPlan, draftOf, requireConfirmable, setResolution } from "./context.ts";
import { count, home, printItems, printResolveHints, report, reportCli, summarize } from "./report.ts";
import { isValidSkillName, withPrefix } from "./transform.ts";
import { treeHash } from "./treehash.ts";
import { select } from "./select.ts";
import { type AddKind, addSource, buildSource } from "./add.ts";
import { adopt } from "./adopt.ts";
import { type UpdateIO, update } from "./update.ts";
import { check as checkSources, realNet } from "./check.ts";
import { formatStatus, readStatus, which, writeStatus } from "./status.ts";
import { readLock } from "./lock.ts";
import { readManifest } from "./manifest.ts";
import { describeSync, sync as syncV2 } from "./sync.ts";
import { isPinnedSpec } from "./validate.ts";

const USAGE = `skillport — one place for skills that vendor installers scatter

  skl register [set] [--json '<entry>']   Add a source (wizard, or JSON for scripts)
  skl status                       What is installed, from where (offline)
  skl doctor [--fix]               Find stray copies, broken or missing links, drift; fix the safe ones
  skl adopt <set> [-y]             Take over copies a vendor already installed, when they match
  skl check [set...]               Is anything new upstream? Changes nothing
  skl add <set> [-y]               First install; asks which skills (or runs the installer) unless -y
  skl update [set...] [-i] [--pick] [-y]   Apply upstream changes; new skills are offered, never auto-installed
                                   -i re-runs the installer interactively; --pick chooses skills again
  skl diff <set> <skill>           What changed in one skill
  skl remove <set>                 Move a set's skills to trash and unregister it
  skl resolve <set> <skill> (--prefix [p] | --rename <name> | --exclude | --undo)
  skl namespace <set> (<prefix> | --off)   Prefix every skill of a set, new ones too
  skl bump <set> [version]         Move a set's pinned installer or package to the latest (or given) version
  skl secret <set>                 Store a set's token in Keychain
  skl sync [--discard-edits]       v2: make ~/.agents/skills match the manifest and lock (offline)
                                   skills you changed in place are kept unless --discard-edits
  skl add <id> (--github <owner/repo> | --installer "<command>" [--unattended "<args>"] | --npm <pkg@ver> --path <dir> | --local <dir>)
           [--prefix <p> | --no-prefix] [-y]   v2: add a source and install its skills
  skl adopt <owner/repo> [--as <id>] [-y]   v2: take over skills you installed with npx skills
  skl which <name>                 v2: the source, original name and version of an installed skill

Flags: --dry-run prints the plan only.  -y skips confirmations.
Registry: ${defaultPaths().registry}`;

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
  const registry = readRegistry(base.registry);
  const paths = withLinkTargets(base, registry);
  const ctx: Ctx = {
    paths,
    registry,
    saveRegistry: (r) => writeRegistry(paths.registry, r),
  };
  // Every command that writes state, staging, the registry or the Keychain
  // takes the lock; status, plain doctor and help do not.
  const writes = ["add", "update", "check", "diff", "remove", "adopt", "register", "resolve", "namespace", "bump", "secret"];
  if (writes.includes(cmd) || (cmd === "doctor" && rest.includes("--fix"))) cleanups.add(acquireLock(paths.stateDir));
  switch (cmd) {
    case "sync":
      return syncCmd(base, rest.includes("--discard-edits"));
    case "register":
      return register(ctx, args[0], rest, flags);
    case "status":
      return fs.existsSync(base.manifest) ? statusV2(base) : status(ctx);
    case "which":
      return whichCmd(base, args[0]);
    case "doctor":
      return doctor(ctx, rest.includes("--fix"), flags);
    case "check":
      return fs.existsSync(base.manifest) ? checkV2(base, args) : check(ctx, args);
    case "add":
      if (V2_KINDS.some((k) => rest.includes(`--${k}`))) return addCmd(base, rest);
      getSet(ctx.registry, args[0]);
      return sync(ctx, args[0], { ...flags, interactive: !flags.yes });
    case "update": {
      if (fs.existsSync(base.manifest)) return updateV2(base, args, rest, flags);
      const ids = args.length ? args : Object.keys(ctx.registry.sets);
      let failed = 0;
      for (const id of ids) failed += await sync(ctx, id, flags);
      return failed ? 1 : 0;
    }
    case "adopt": {
      // v2 takes an npx skills source (owner/repo or URL); v1 a set id.
      if (args[0]?.includes("/")) return adoptCmd(base, args[0], rest);
      const set = getSet(ctx.registry, args[0]);
      if (!isManaged(set)) throw new Error(`"${args[0]}" is installed by npx skills, which already took over what it found; nothing to adopt.`);
      return sync(ctx, args[0], { ...flags, adopt: true });
    }
    case "diff":
      return diff(ctx, args[0], args[1]);
    case "remove":
      return remove(ctx, args[0], flags);
    case "resolve":
      return resolveCmd(ctx, args, rest, flags);
    case "namespace":
      return namespaceCmd(ctx, args, rest.includes("--off"), flags);
    case "bump":
      return bumpCmd(ctx, args, flags);
    case "secret":
      getSet(ctx.registry, args[0]);
      storeSecret(args[0]);
      console.log(`Stored secret for "${args[0]}".`);
      return 0;
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

const V2_KINDS: AddKind[] = ["github", "installer", "npm", "local"];

/** The word after `flag`, which may itself start with "-" (e.g. --unattended "-y"). */
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
  const kinds = V2_KINDS.filter((k) => rest.includes(`--${k}`));
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

/** The manifest, the paths with its link targets, and the lock: what every v2 command starts from. */
function v2(base: Paths) {
  const manifest = readManifest(base.manifest);
  const paths = withLinkTargets(base, manifest, base.manifest);
  return { manifest, paths, lock: readLock(paths.lockFile) };
}

function checkV2(base: Paths, ids: string[]): number {
  const { manifest, paths, lock } = v2(base);
  cleanups.add(acquireLock(paths.sklDir));
  const staging = path.join(paths.sklDir, "check");
  cleanups.add(() => fs.rmSync(staging, { recursive: true, force: true }));
  const result = checkSources(paths, manifest, lock, readStatus(paths.statusFile), ids, realNet(staging));
  writeStatus(paths.statusFile, result);
  console.log(formatStatus(manifest, lock, result));
  for (const [id, s] of Object.entries(result.sources)) {
    if (s.state === "updates" && s.link && (!ids.length || ids.includes(id))) console.log(`\n${id}: ${s.link}`);
  }
  return 0;
}

async function updateV2(base: Paths, ids: string[], rest: string[], flags: Flags): Promise<number> {
  const { manifest, paths, lock } = v2(base);
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

function statusV2(base: Paths): number {
  const { manifest, paths, lock } = v2(base);
  console.log(formatStatus(manifest, lock, readStatus(paths.statusFile)));
  return 0;
}

function whichCmd(base: Paths, name: string | undefined): number {
  if (!name) throw new Error("Usage: skl which <installed name>");
  const { manifest, paths, lock } = v2(base);
  console.log(which(paths, manifest, lock, name));
  return 0;
}

function syncCmd(base: Paths, discardEdits: boolean): number {
  const manifest = readManifest(base.manifest);
  const paths = withLinkTargets(base, manifest, base.manifest);
  cleanups.add(acquireLock(paths.sklDir));
  const lines = describeSync(syncV2(paths, manifest, readLock(paths.lockFile), { discardEdits }));
  console.log(lines.length ? lines.join("\n") : "up to date");
  return 0;
}

async function register(ctx: Ctx, id: string | undefined, rest: string[], flags: Flags): Promise<number> {
  const jsonAt = rest.indexOf("--json");
  if (jsonAt >= 0) {
    if (!id) throw new Error(USAGE);
    const set = JSON.parse(rest[jsonAt + 1] ?? "") as SkillSet;
    const problems = validateSet(id, set, ctx.registry);
    if (problems.length) throw new Error(`Not registered:\n  ${problems.join("\n  ")}`);
    console.log(`Plan: add to ${ctx.paths.registry}\n${JSON.stringify({ [id]: set }, null, 2)}`);
    if (!(await confirmChange(flags, "Save it?", "dry run: registry unchanged."))) return 0;
    return saveSet(ctx, id, set);
  }
  if (!isInteractive()) throw new Error("register asks questions; without a terminal pass: skl register <set> --json '<entry>'");
  intro("skillport · register a skill source");
  if (!id) {
    id = await ask("Name for this source", {
      placeholder: "newvendor",
      validate: (v) => (validateSet(v, { type: "skills-cli", source: "a/b" }, ctx.registry)[0] ?? undefined),
    });
  } else if (ctx.registry.sets[id]) {
    throw new Error(`Set "${id}" already exists in ${ctx.paths.registry}.`);
  }
  const { set, secret } = await askForSet(id, ctx.paths, ctx.registry);
  const problems = validateSet(id, set, ctx.registry);
  if (problems.length) throw new Error(`Not registered:\n  ${problems.join("\n  ")}`);
  note(JSON.stringify({ [id]: set }, null, 2), "Registry entry");
  if (!(await confirm("Save it?"))) {
    outro("Nothing saved.");
    return 0;
  }
  saveSet(ctx, id, set);
  if (secret) {
    storeSecretValue(id, secret);
    log.success(`Token stored in Keychain (service skillport, account ${id}).`);
  }
  log.success(`Registered "${id}".`);
  const prompt = set.type === "installer" ? "Install now? The installer's own questions come next." : "Install now?";
  if (!(await confirm(prompt))) {
    outro(`Install later with: skl add ${id}`);
    return 0;
  }
  outro(set.type === "installer" ? `Running ${id}'s installer in a sandbox` : `Installing ${id}`);
  return sync(ctx, id, { yes: false, dryRun: false, interactive: set.type === "installer" });
}

/** Write an entry its caller has already validated and shown. */
function saveSet(ctx: Ctx, id: string, set: SkillSet): number {
  ctx.registry.sets[id] = set;
  ctx.saveRegistry(ctx.registry);
  if (!isInteractive()) console.log(`Registered "${id}" in ${ctx.paths.registry}.${set.type === "installer" && set.secret ? ` Store its token with: skl secret ${id}` : ""}`);
  return 0;
}

/** The pinned package of a set and the latest published version (null if unknown). */
function versions(set: ManagedSet, staging: string): { name: string; pinned: string; latest: string | null } | null {
  const pin = pinnedPackage(set);
  return pin ? { name: pin.name, pinned: pin.version, latest: latestVersion(pin.name, staging) } : null;
}

/** "A newer pinned package exists" line for installer and npm sets, or null. */
function versionHint(id: string, set: ManagedSet, staging: string): string | null {
  const v = versions(set, staging);
  if (!v?.latest || v.latest === v.pinned) return null;
  return `⬆ ${v.name}@${v.latest} is out (pinned ${v.pinned}). To upgrade: skl bump ${id}`;
}

// Staging folders hold vendor content and the installer's fake HOME, where an
// installer may have saved its token. They are removed on every exit path,
// including errors and Ctrl-C.
const cleanups = new Set<() => void>();
process.on("exit", () => cleanups.forEach((f) => f()));
process.on("SIGINT", () => process.exit(130));
// A closed terminal or a kill should clean up too.
process.on("SIGHUP", () => process.exit(129));
process.on("SIGTERM", () => process.exit(143));

function stagingFor(ctx: Ctx, id: string): string {
  const staging = path.join(ctx.paths.stateDir, "staging", id);
  const clean = () => fs.rmSync(staging, { recursive: true, force: true });
  cleanups.add(clean);
  return staging;
}

function dropStaging(staging: string): void {
  fs.rmSync(staging, { recursive: true, force: true });
}

/** Fetch a set into staging; `replan` reads `ctx.registry` each time. */
function fetchSet(
  ctx: Ctx,
  id: string,
  set: ManagedSet,
  staging: string,
  interactive: boolean,
  adopt: boolean | string[] = false,
  sel: { want?: string[]; declined?: string[] } = {},
) {
  const vendorDir = acquire(id, set, staging, { interactive });
  return (adoptNow = adopt) =>
    plan({
      paths: ctx.paths,
      setId: id,
      set: getSet(ctx.registry, id) as ManagedSet,
      state: readState(ctx.paths.stateDir),
      lock: readSkillLock(ctx.paths.skillLock),
      pluginSkills: pluginSkillNames(ctx.paths.claudePlugins),
      vendorDir,
      staging,
      links: linkDirsFor(ctx.paths, getSet(ctx.registry, id)),
      fromInteractiveRun: interactive,
      adopt: adoptNow,
      want: sel.want,
      declined: sel.declined,
    });
}

/** Print a "needs you" notice for an installer stuck on a question; false for other errors. */
function noticeIfNeedsYou(e: unknown, id: string): boolean {
  if (!(e instanceof NeedsInteraction)) return false;
  console.log(`\n■ ${id}: ${e.message}`);
  return true;
}

/** Update another set non-interactively, for "rename the other side". */
const updateSet = (ctx: Ctx, id: string) => sync(ctx, id, { yes: false, interactive: false, dryRun: false });

async function sync(ctx: Ctx, id: string, flags: Flags): Promise<number> {
  const entry = getSet(ctx.registry, id);
  if (!isManaged(entry)) return syncCli(ctx, id, flags);
  const set = entry;
  const interactive = flags.interactive && set.type === "installer";
  if (interactive && !isInteractive()) throw new Error("Interactive install needs a terminal; pass -y to install everything.");
  if (!interactive && !runsUnattended(set)) {
    console.log(`■ ${id}: only runs interactively; skipped. Run: skl update ${id} -i`);
    return 0;
  }
  requireConfirmable(flags);
  if (set.type === "installer" && set.secret === "keychain" && !hasSecret(id)) {
    if (!isInteractive()) throw new Error(`No Keychain secret for "${id}". Run: skl secret ${id}`);
    storeSecretValue(id, await askSecret(`Token for "${id}" (stored in Keychain, never in the registry)`));
    log.success("Token stored in Keychain.");
  }
  // Collision answers go into a draft and reach the registry file only when
  // the plan is applied, never on --dry-run or a "no".
  const draft = draftOf(ctx);
  let resolved = false;
  const staging = stagingFor(ctx, id);
  try {
    // `skl adopt` takes over everything; "take over" in the prompt, one name.
    let adopt: boolean | string[] = flags.adopt ? true : [];
    const sel: { want?: string[]; declined?: string[] } = {};
    const replan = fetchSet(draft, id, set, staging, interactive, adopt, sel);
    const prev = readState(ctx.paths.stateDir).sets[id];
    let pending: string[] = [];
    // After an interactive installer run, its output is the selection.
    if (!interactive) {
      const installed = Object.entries(prev?.skills ?? {}).map(([n, s]) => s.original ?? n);
      const choice = await select({
        setId: id,
        available: replan(adopt).skills.map((s) => s.original),
        exclude: [],
        installed: installed.length ? installed : null,
        declined: prev?.declined ?? [],
        flags,
        pick: Boolean(flags.pick),
      });
      sel.want = choice.want;
      sel.declined = choice.declined;
      pending = choice.pending;
    }
    const declinedChanged = sel.declined !== undefined && [...sel.declined].sort().join() !== [...(prev?.declined ?? [])].sort().join();
    let p = replan(adopt);
    while (p.collisions.length) {
      if (flags.yes || !isInteractive()) {
        report(p);
        printResolveHints(ctx.paths, id, true, p.collisions);
        return 1;
      }
      for (const c of p.collisions) {
        const outcome = await resolveInteractively(ctx, draft, id, c, { adopt: adopt === true || adopt.includes(c.name), dryRun: flags.dryRun, update: updateSet });
        if (outcome === "adopt" && Array.isArray(adopt)) adopt = [...adopt, c.name];
        else if (outcome === "other" && c.holderId) draft.registry.sets[c.holderId] = structuredClone(ctx.registry.sets[c.holderId]);
        else resolved = true;
      }
      p = replan(adopt);
    }
    // New ones are listed once, as new; the rest you declined earlier.
    p.unselected = p.unselected.filter((n) => !pending.includes(n));
    report(p);
    printPending(id, pending);
    const hint = versionHint(id, set, staging);
    if (hint) console.log(`  ${hint}`);
    if (p.errors.length) return 1;
    const work =
      p.skills.some((s) => s.write) || p.removed.length > 0 || p.relink || p.adopted.length > 0 || p.strays.length > 0 ||
      p.captured !== undefined || resolved || declinedChanged;
    if (!(await confirmPlan(flags, work, resolved))) return 0;
    const trash = apply(ctx.paths, p, readState(ctx.paths.stateDir), draft.registry, ctx.saveRegistry);
    if (resolved) ctx.saveRegistry(draft.registry);
    ctx.registry = draft.registry;
    console.log(`  applied.${fs.existsSync(trash) ? ` Previous versions: ${trash}` : ""}`);
    return 0;
  } catch (e) {
    // "Stop", Esc or Ctrl-C ends the whole command, not just this set.
    if (e instanceof Cancelled) throw e;
    // Not a failure of the set: it needs you. Reported, not counted as an error.
    if (noticeIfNeedsYou(e, id)) return 0;
    console.error(`✗ ${id}: ${(e as Error).message}`);
    return 1;
  } finally {
    dropStaging(staging);
  }
}

async function syncCli(ctx: Ctx, id: string, flags: Flags): Promise<number> {
  requireConfirmable(flags);
  const draft = draftOf(ctx);
  let resolved = false;
  try {
    const set = getSet(draft.registry, id) as SkillsCliSet;
    const available = listSource(ctx.paths, set.source);
    const prevRecord = readState(ctx.paths.stateDir).cli?.[id];
    // npx skills runs with -y, so its own skill picker never shows; this is
    // that question, asked by skillport. -i means the same as --pick here.
    const choice = await select({
      setId: id,
      available,
      exclude: set.exclude ?? [],
      installed: prevRecord?.skills.length ? prevRecord.skills : null,
      declined: prevRecord?.declined ?? [],
      flags,
      pick: Boolean(flags.pick || flags.interactive),
    });
    const declinedChanged = [...choice.declined].sort().join() !== [...(prevRecord?.declined ?? [])].sort().join();
    const replan = cliPlanner(draft, id, available, choice.want);
    let p = replan();
    while (p.collisions.length) {
      if (flags.yes || !isInteractive()) {
        reportCli(p, []);
        printResolveHints(ctx.paths, id, false, p.collisions);
        return 1;
      }
      for (const c of p.collisions) {
        const outcome = await resolveCliCollision(ctx, draft, id, c, { dryRun: flags.dryRun, update: updateSet });
        if (outcome === "other" && c.holderId) draft.registry.sets[c.holderId] = structuredClone(ctx.registry.sets[c.holderId]);
        else resolved = true;
      }
      p = replan();
    }
    const lock = readSkillLock(ctx.paths.skillLock);
    // What this set will own once applied: everything it wants that is (or
    // will be) installed, whether or not upstream changed.
    const ownedAfter = [...p.add, ...p.update].sort();
    const upstream = upstreamChanges(lock, p.update);
    p.update = [...upstream.changed, ...upstream.unknown];
    p.unselected = p.unselected.filter((n) => !choice.pending.includes(n));
    reportCli(p, upstream.unknown);
    printPending(id, choice.pending);
    const links = linkDirsFor(ctx.paths, getSet(draft.registry, id));
    const before = readState(ctx.paths.stateDir).cli?.[id]?.skills ?? [];
    const recordChanged = ownedAfter.join() !== [...before].sort().join();
    // Skills that stay installed must follow the set's links too. New ones
    // get Claude Code's link from npx skills and the rest after it runs.
    const linkChanges = cliLinkChanges(ctx.paths, ownedAfter.filter((n) => !p.add.includes(n)), links);
    printItems("link", linkChanges.add.map(home));
    printItems("unlink", linkChanges.remove.map(home));
    const work =
      p.add.length > 0 || p.update.length > 0 || p.remove.length > 0 || resolved || recordChanged || declinedChanged ||
      linkChanges.add.length > 0 || linkChanges.remove.length > 0;
    if (!(await confirmPlan(flags, work, resolved))) return 0;
    // The prompt may have sat for a while: check again right before npx
    // skills runs, since it overwrites whatever is at those paths.
    const recheck = replan();
    const fresh = recheck.collisions.filter((c) => p.add.includes(c.name));
    if (fresh.length) {
      throw new Error(`Something changed since the plan was made:\n  ${fresh.map((c) => `${c.name} now collides with ${c.holder}`).join("\n  ")}`);
    }
    // Ownership is written after every npx skills step that succeeds.
    const record = (skills: string[]) => {
      const state = readState(ctx.paths.stateDir);
      state.cli = { ...(state.cli ?? {}), [id]: {
          syncedAt: new Date().toISOString(),
          skills: [...new Set(skills)].sort(),
          ...(choice.declined.length ? { declined: [...choice.declined].sort() } : {}),
        },
      };
      writeState(ctx.paths.stateDir, state);
    };
    let owned = [...before];
    applyCli(ctx.paths, p, links, (step, names) => {
      owned = step === "remove" ? owned.filter((n) => !names.includes(n)) : [...owned, ...names];
      record(owned);
    });
    record(ownedAfter);
    applyCliLinks(ctx.paths, linkChanges);
    applyCliLinks(ctx.paths, cliLinkChanges(ctx.paths, p.add, links));
    if (resolved) ctx.saveRegistry(draft.registry);
    ctx.registry = draft.registry;
    console.log("  applied.");
    return 0;
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    console.error(`✗ ${id}: ${(e as Error).message}`);
    return 1;
  }
}

/**
 * `skl resolve`: one registry edit, shown as a before/after plan first like
 * every other change (--dry-run stops there; a terminal confirms; -y without).
 */
async function resolveCmd(ctx: Ctx, args: string[], rest: string[], flags: Flags): Promise<number> {
  const [id, skill] = args;
  const modeAt = rest.findIndex((a) => ["--exclude", "--undo", "--prefix", "--rename"].includes(a));
  const mode = rest[modeAt];
  const value = rest[modeAt + 1] && !rest[modeAt + 1].startsWith("-") ? rest[modeAt + 1] : undefined;
  if (!id || !skill || !mode) throw new Error(USAGE);
  const set = getSet(ctx.registry, id);
  let change: Resolution;
  if (mode === "--exclude") change = { exclude: true };
  else if (mode === "--undo") change = { undo: true };
  else {
    const prefix = value ?? prefixOf(set, id);
    const to = mode === "--prefix" ? withPrefix(skill, prefix) : value;
    if (!to || !isValidSkillName(to)) throw new Error(`"${to ?? ""}" is not a valid skill name.`);
    change = { to, reason: "resolved by hand" };
  }
  const draft = draftOf(ctx);
  setResolution(draft, id, skill, change);
  const show = (r: Registry) => {
    const e = r.sets[id] as { rename?: Record<string, { to: string }>; exclude?: string[] };
    const renamed = e.rename?.[skill]?.to;
    return renamed ? `renamed to ${renamed}` : e.exclude?.includes(skill) ? "excluded" : "installed as is";
  };
  console.log(`Plan: ${id}/${skill}: ${show(ctx.registry)} → ${show(draft.registry)} (in ${ctx.paths.registry})`);
  if (!(await confirmChange(flags, "Save it?", "dry run: registry unchanged."))) return 0;
  ctx.registry = draft.registry;
  ctx.saveRegistry(ctx.registry);
  console.log(`Recorded. Run: skl update ${id}`);
  return 0;
}

/**
 * `skl namespace`: set or clear a set's namespace. The plan lists the names
 * of its installed skills before and after; skl update applies it.
 */
async function namespaceCmd(ctx: Ctx, args: string[], off: boolean, flags: Flags): Promise<number> {
  const [id, value] = args;
  if (!id || (!value && !off) || (value && off)) throw new Error(USAGE);
  const set = getSet(ctx.registry, id);
  if (!isManaged(set)) throw new Error(`"${id}" is installed by npx skills, which owns its names; a namespace cannot apply.`);
  if (value && !isValidSkillName(value)) throw new Error(`"${value}" is not a valid prefix (a-z, 0-9, single -).`);
  const draft = draftOf(ctx);
  const next = draft.registry.sets[id] as ManagedSet;
  if (off) delete next.namespace;
  else next.namespace = value;
  const installed = Object.entries(readState(ctx.paths.stateDir).sets[id]?.skills ?? {}).map(([n, s]) => s.original ?? n);
  const moves = installed.map((o) => [skillName(set, o), skillName(next, o)]).filter(([a, b]) => a !== b);
  console.log(`Plan: ${id}: namespace ${set.namespace ?? "(none)"} → ${next.namespace ?? "(none)"} (in ${ctx.paths.registry})`);
  for (const [a, b] of moves) console.log(`  ${a} → ${b}`);
  if (!moves.length) console.log("  no installed skill changes name.");
  if (!(await confirmChange(flags, "Save it?", "dry run: registry unchanged."))) return 0;
  ctx.registry = draft.registry;
  ctx.saveRegistry(ctx.registry);
  console.log(`Recorded. Run: skl update ${id}`);
  return 0;
}

/**
 * `skl bump`: move a set's pin to the latest version on npm, or the one you
 * name. It checks the version exists and is newer, and shows when it was
 * published; whether the new code is safe is still yours to judge.
 */
async function bumpCmd(ctx: Ctx, args: string[], flags: Flags): Promise<number> {
  const [id, wanted] = args;
  if (!id) throw new Error(USAGE);
  const set = getSet(ctx.registry, id);
  if (!isManaged(set)) throw new Error(`"${id}" is installed by npx skills; it has no version to pin.`);
  const pin = pinnedPackage(set);
  if (!pin) throw new Error(`"${id}" has no pinned package (name@x.y.z) in the registry.`);
  const staging = stagingFor(ctx, id);
  try {
    const times = publishTimes(pin.name, staging);
    const target = wanted ?? latestVersion(pin.name, staging);
    if (!times || !target) throw new Error(`npm did not answer for ${pin.name}; try again later.`);
    if (!isPinnedSpec(`${pin.name}@${target}`)) throw new Error(`"${target}" is not an exact version (x.y.z).`);
    if (!times[target]) throw new Error(`${pin.name}@${target} does not exist on npm.`);
    if (compareVersions(target, pin.version) <= 0) {
      console.log(`${id}: ${pin.name}@${pin.version} is ${target === pin.version ? (wanted ? "already that version" : "already the latest") : `newer than ${target}`}; nothing to bump.`);
      return 0;
    }
    const days = Math.floor((Date.now() - Date.parse(times[target])) / 86_400_000);
    const draft = draftOf(ctx);
    const next = draft.registry.sets[id] as ManagedSet;
    const spec = `${pin.name}@${target}`;
    if (next.type === "npm") next.package = spec;
    else next.command = next.command.map((w) => (w === `${pin.name}@${pin.version}` ? spec : w));
    console.log(`Plan: ${id}: ${pin.name} ${pin.version} → ${target} (in ${ctx.paths.registry})`);
    console.log(`  published ${times[target].slice(0, 10)} (${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`})`);
    if (days < 3) console.log("  ⚠ very new: if anything looks off, wait a few days before running it.");
    if (!(await confirmChange(flags, "Save it?", "dry run: registry unchanged."))) return 0;
    ctx.registry = draft.registry;
    ctx.saveRegistry(ctx.registry);
    console.log(`Recorded. Run: skl update ${id}`);
    return 0;
  } finally {
    dropStaging(staging);
  }
}

async function check(ctx: Ctx, ids: string[]): Promise<number> {
  let failed = 0;
  for (const id of ids.length ? ids : Object.keys(ctx.registry.sets)) {
    const set = getSet(ctx.registry, id);
    try {
      if (!isManaged(set)) {
        checkCli(ctx, id);
        continue;
      }
      if (!runsUnattended(set)) {
        console.log(`■ ${id}: only runs interactively; check skipped. Run: skl update ${id} -i`);
        continue;
      }
      const staging = stagingFor(ctx, id);
      try {
        if (set.type === "npm") {
          // A pinned package never changes; only a newer version can. When
          // there is one, plan against it to show what upgrading would do.
          const v = versions(set, staging);
          const latest = v?.latest;
          if (!v || !latest) {
            reportChosen(fetchSet(ctx, id, set, staging, false, false, chosen(ctx, id))(), id, chosen(ctx, id));
            console.log(`  could not look up the latest version of ${set.package}.`);
            continue;
          }
          if (latest === v.pinned) {
            // Same version, but other sets or folders may have changed since:
            // plan it to report collisions and edits.
            reportChosen(fetchSet(ctx, id, set, staging, false, false, chosen(ctx, id))(), id, chosen(ctx, id));
            console.log(`  ${set.package} is the latest.`);
            continue;
          }
          const upgraded: ManagedSet = { ...set, package: `${v.name}@${latest}` };
          const draft = draftOf(ctx);
          draft.registry.sets[id] = upgraded;
          const p = fetchSet(draft, id, upgraded, staging, false, false, chosen(ctx, id))();
          console.log(`\n${v.name}@${latest} is out (pinned ${v.pinned}). After skl bump ${id}:`);
          reportChosen(p, id, chosen(ctx, id));
          continue;
        }
        reportChosen(fetchSet(ctx, id, set, staging, false, false, chosen(ctx, id))(), id, chosen(ctx, id));
        const hint = versionHint(id, set, staging);
        if (hint) console.log(`  ${hint}`);
      } finally {
        dropStaging(staging);
      }
    } catch (e) {
      if (noticeIfNeedsYou(e, id)) continue;
      failed++;
      console.error(`✗ ${id}: ${(e as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

function checkCli(ctx: Ctx, id: string): void {
  const record = readState(ctx.paths.stateDir).cli?.[id];
  const declined = record?.declined ?? [];
  const p = cliPlanner(ctx, id, undefined, record?.skills.length ? record.skills : undefined)();
  const pending = p.unselected.filter((n) => !declined.includes(n));
  p.unselected = p.unselected.filter((n) => declined.includes(n));
  const upstream = upstreamChanges(readSkillLock(ctx.paths.skillLock), p.update);
  p.update = [...upstream.changed, ...upstream.unknown];
  reportCli(p, upstream.unknown);
  printPending(id, pending);
  for (const [name, url] of Object.entries(upstream.links)) console.log(`    ${name}: ${url}`);
  if (upstream.unknown.length) console.log("  can't tell = not on GitHub, or GitHub did not answer; update re-fetches them.");
  if (!p.add.length && !p.update.length && !p.remove.length) console.log("  up to date.");
}

/** Plan a skills-cli set: lists its source once, re-reads lock and state each call. */
function cliPlanner(ctx: Ctx, id: string, available?: string[], want?: string[]): () => CliPlan {
  const { source } = getSet(ctx.registry, id) as SkillsCliSet;
  available ??= listSource(ctx.paths, source);
  return () =>
    planCli({
      paths: ctx.paths,
      setId: id,
      set: getSet(ctx.registry, id) as SkillsCliSet,
      available,
      lock: readSkillLock(ctx.paths.skillLock),
      state: readState(ctx.paths.stateDir),
      pluginSkills: pluginSkillNames(ctx.paths.claudePlugins),
      want,
    });
}

/** What state says you chose for a managed set: installed (null if never) and declined vendor names. */
function chosen(ctx: Ctx, id: string): { want?: string[]; declined: string[] } {
  const st = readState(ctx.paths.stateDir).sets[id];
  const installed = Object.entries(st?.skills ?? {}).map(([n, s]) => s.original ?? n);
  return { want: installed.length ? installed : undefined, declined: st?.declined ?? [] };
}

/** Report a plan made from what you chose: new vendor skills listed as new, the rest as declined. */
function reportChosen(p: Plan, id: string, choice: { declined: string[] }): void {
  const pending = p.unselected.filter((n) => !choice.declined.includes(n));
  p.unselected = p.unselected.filter((n) => choice.declined.includes(n));
  report(p);
  printPending(id, pending);
}

/** New skills nobody decided on yet (no terminal, or -y). */
function printPending(id: string, pending: string[]): void {
  if (!pending.length) return;
  printItems("available", pending);
  console.log(`  ${pending.length} not installed yet. To choose: skl update ${id} --pick`);
}

function status(ctx: Ctx): number {
  const state = readState(ctx.paths.stateDir);
  const lock = readSkillLock(ctx.paths.skillLock);
  const pad = "".padEnd(15);
  let problems = 0;
  for (const [id, set] of Object.entries(ctx.registry.sets)) {
    if (!isManaged(set)) {
      const fromSource = lockedFor(lock, set.source);
      const record = state.cli?.[id];
      const owned = fromSource.filter((n) => record?.skills.includes(n));
      const when = record ? `synced ${new Date(record.syncedAt).toLocaleString("sv").slice(0, 16)}  ` : "";
      console.log(`${id.padEnd(15)}${"skills-cli".padEnd(13)}${count(owned.length, "skill").padEnd(10)}${when}${set.source}`);
      if (set.exclude?.length) console.log(`${pad}  excluded: ${set.exclude.join(", ")}`);
      const others = fromSource.filter((n) => !owned.includes(n));
      if (others.length) console.log(`${pad}  left alone (installed outside this set): ${summarize(others)}`);
      continue;
    }
    const st = state.sets[id];
    const n = Object.keys(st?.skills ?? {}).length;
    const when = st
      ? `${count(n, "skill").padEnd(10)}synced ${new Date(st.syncedAt).toLocaleString("sv").slice(0, 16)}${st.source ? `  ${st.source}` : ""}`
      : "not installed";
    console.log(`${id.padEnd(15)}${set.type.padEnd(13)}${when}`);
    for (const [name, s] of Object.entries(st?.skills ?? {})) {
      const rule = s.original ? set.rename?.[s.original] : undefined;
      if (rule) console.log(`${pad}  ${s.original} → ${name}   (${rule.reason}, ${rule.at})`);
      const dest = path.join(ctx.paths.skillsDir, name);
      if (!fs.existsSync(dest)) {
        problems++;
        console.log(`${pad}  ✗ ${name}: missing from ${ctx.paths.skillsDir}`);
      } else if (treeHash(dest) !== s.installed) {
        problems++;
        console.log(`${pad}  ⚠ ${name}: edited on disk since install`);
      }
    }
    if (set.exclude?.length) console.log(`${pad}  excluded: ${set.exclude.join(", ")}`);
  }
  if (!Object.keys(ctx.registry.sets).length) console.log(`No sets registered. Run: skl register`);
  const found = diagnose(ctx.paths, ctx.registry, state, lock);
  const stale = found.filter((f) => f.kind === "stale-rule");
  if (stale.length) {
    console.log("\nRename rules you can undo:");
    for (const f of stale) console.log(`  ${f.message}`);
  }
  const otherProblems = found.filter((f) => f.kind !== "edited" && f.kind !== "stale-rule").length;
  if (problems || otherProblems) console.log(`\n${count(problems + otherProblems, "problem")} found. Details: skl doctor`);
  return 0;
}

/**
 * Without --fix, a report. With --fix, the fixes are listed as a plan first,
 * like every other command that changes files: confirm on a terminal, -y
 * without one, --dry-run to stop at the plan.
 */
async function doctor(ctx: Ctx, fix: boolean, flags: Flags): Promise<number> {
  // v2 once a manifest exists; v1 until then.
  const v2 = fs.existsSync(ctx.paths.manifest);
  let trashAt = path.join(ctx.paths.stateDir, "trash");
  let findings: Finding[];
  if (v2) {
    const manifest = readManifest(ctx.paths.manifest);
    const paths = withLinkTargets(ctx.paths, manifest, ctx.paths.manifest);
    if (fix) cleanups.add(acquireLock(paths.sklDir));
    findings = diagnoseV2(paths, manifest, readLock(paths.lockFile));
    trashAt = path.join(paths.sklDir, "trash");
  } else {
    findings = diagnose(ctx.paths, ctx.registry, readState(ctx.paths.stateDir), readSkillLock(ctx.paths.skillLock));
  }
  if (!findings.length) {
    console.log("No problems found.");
    return 0;
  }
  const order: Kind[] = ["collision", "invalid", "missing", "stray-copy", "broken-link", "missing-link", "edited", "no-note", "unowned", "stale-rule"];
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
  console.log(`\nPlan: fix the ${count(fixable.length, "problem")} marked •; moved copies go to ${trashAt}.`);
  if (!(await confirmChange(flags, "Fix them?", "dry run: nothing changed."))) return 0;
  for (const f of fixable) {
    f.fix!();
    console.log(`  ✓ ${f.message}`);
  }
  return findings.some((f) => !f.fix) ? 1 : 0;
}

function diff(ctx: Ctx, id: string | undefined, skill: string | undefined): number {
  if (!id || !skill) throw new Error(USAGE);
  const set = getSet(ctx.registry, id);
  if (!isManaged(set)) throw new Error(`"${id}" is installed by npx skills; compare upstream on its source instead.`);
  const staging = stagingFor(ctx, id);
  try {
    let found: Plan["skills"][number] | undefined;
    try {
      found = fetchSet(ctx, id, set, staging, false)().skills.find((x) => x.name === skill || x.original === skill);
    } catch (e) {
      if (noticeIfNeedsYou(e, id)) return 0;
      throw e;
    }
    const s = found;
    if (!s) throw new Error(`"${skill}" is not in set "${id}".`);
    spawnSync("diff", ["-ru", path.join(ctx.paths.skillsDir, s.name), s.staged], { stdio: "inherit" });
    return 0;
  } finally {
    dropStaging(staging);
  }
}

async function remove(ctx: Ctx, maybeId: string | undefined, flags: Flags): Promise<number> {
  const set = getSet(ctx.registry, maybeId);
  const id = maybeId!; // getSet threw if it was missing
  const state = readState(ctx.paths.stateDir);
  // A skills-cli set removes only what it recorded installing; other skills
  // from the same source (yours by hand, or older) are left alone.
  const recorded = new Set(state.cli?.[id]?.skills ?? []);
  const names = isManaged(set)
    ? Object.keys(state.sets[id]?.skills ?? {})
    : lockedFor(readSkillLock(ctx.paths.skillLock), set.source).filter((n) => recorded.has(n));
  const how = isManaged(set) ? "moved to trash, links removed" : "removed through npx skills";
  console.log(`Remove set "${id}": ${count(names.length, "skill")} ${how}; the set is unregistered.`);
  if (!(await confirmChange(flags, "Continue?", "dry run: nothing removed."))) return 0;
  // Re-read after the prompt so what is removed is what is there now.
  if (isManaged(set)) removeManaged(ctx.paths, id, readState(ctx.paths.stateDir));
  else {
    if (names.length) removeCliSkills(ctx.paths, names);
    const after = readState(ctx.paths.stateDir);
    if (after.cli) delete after.cli[id];
    writeState(ctx.paths.stateDir, after);
  }
  delete ctx.registry.sets[id];
  ctx.saveRegistry(ctx.registry);
  console.log("Done.");
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Cancelled)) console.error((e as Error).message);
  process.exitCode = e instanceof Cancelled ? 130 : 1;
}
