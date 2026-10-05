import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { acquire, latestVersion, pinnedPackage } from "./acquire.ts";
import { acquireLock, apply, removeManaged } from "./apply.ts";
import { storeSecret, storeSecretValue } from "./keychain.ts";
import { type CliPlan, applyCli, listSource, lockedFor, planCli, upstreamChanges } from "./skillscli.ts";
import { type Collision, type Plan, plan } from "./plan.ts";
import { pluginSkillNames } from "./plugins.ts";
import { askForSet, validateSet } from "./register.ts";
import { Cancelled, ask, choose, confirm, intro, isInteractive, log, note, outro } from "./prompt.ts";
import {
  type ManagedSet,
  type Paths,
  type Registry,
  type SkillSet,
  type SkillsCliSet,
  defaultPaths,
  getSet,
  isManaged,
  linkDirsFor,
  readRegistry,
  runsUnattended,
  writeRegistry,
} from "./registry.ts";
import { readSkillLock, readState } from "./state.ts";
import { isValidSkillName, withPrefix } from "./transform.ts";
import { treeHash } from "./treehash.ts";

const USAGE = `skillport — one place for skills that vendor installers scatter

  skl register [set] [--json '<entry>']   Add a source (wizard, or JSON for scripts)
  skl status                       What is installed, from where (offline)
  skl check [set...]               Is anything new upstream? Changes nothing
  skl add <set> [-y]               First install; installers run interactively unless -y
  skl update [set...] [-i] [-y]    Apply upstream changes; -i re-runs the installer interactively
  skl diff <set> <skill>           What changed in one skill
  skl remove <set>                 Move a set's skills to trash and unregister it
  skl resolve <set> <skill> (--prefix [p] | --rename <name> | --exclude | --undo)
  skl secret <set>                 Store a set's token in Keychain

Flags: --dry-run prints the plan only.  -y skips confirmations.
Registry: ${defaultPaths().registry}`;

interface Flags {
  yes: boolean;
  interactive: boolean;
  dryRun: boolean;
}

interface Ctx {
  paths: Paths;
  registry: Registry;
  saveRegistry: (r: Registry) => void;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags: Flags = {
    yes: rest.includes("-y") || rest.includes("--yes"),
    interactive: rest.includes("-i"),
    dryRun: rest.includes("--dry-run"),
  };
  const args = rest.filter((a) => !a.startsWith("-"));
  const paths = defaultPaths();
  const ctx: Ctx = {
    paths,
    registry: readRegistry(paths.registry),
    saveRegistry: (r) => writeRegistry(paths.registry, r),
  };
  if (["add", "update", "check", "diff", "remove"].includes(cmd)) cleanups.add(acquireLock(paths));
  switch (cmd) {
    case "register":
      return register(ctx, args[0], rest);
    case "status":
      return status(ctx);
    case "check":
      return check(ctx, args);
    case "add":
      getSet(ctx.registry, args[0]);
      return sync(ctx, args[0], { ...flags, interactive: !flags.yes });
    case "update": {
      const ids = args.length ? args : Object.keys(ctx.registry.sets);
      let failed = 0;
      for (const id of ids) failed += await sync(ctx, id, flags);
      return failed ? 1 : 0;
    }
    case "diff":
      return diff(ctx, args[0], args[1]);
    case "remove":
      return remove(ctx, args[0], flags);
    case "resolve":
      return resolveCmd(ctx, rest);
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

async function register(ctx: Ctx, id: string | undefined, rest: string[]): Promise<number> {
  const jsonAt = rest.indexOf("--json");
  if (jsonAt >= 0) {
    if (!id) throw new Error(USAGE);
    const set = JSON.parse(rest[jsonAt + 1] ?? "") as SkillSet;
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
  const { set, secret } = await askForSet(id, ctx.paths);
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

function saveSet(ctx: Ctx, id: string, set: SkillSet): number {
  const problems = validateSet(id, set, ctx.registry);
  if (problems.length) throw new Error(`Not registered:\n  ${problems.join("\n  ")}`);
  ctx.registry.sets[id] = set;
  ctx.saveRegistry(ctx.registry);
  if (!isInteractive()) console.log(`Registered "${id}" in ${ctx.paths.registry}.${set.type === "installer" && set.secret ? ` Store its token with: skl secret ${id}` : ""}`);
  return 0;
}

/** "A newer pinned package exists" line for installer and npm sets, or null. */
function versionHint(set: ManagedSet, staging: string): string | null {
  const pin = pinnedPackage(set);
  const latest = pin && latestVersion(pin.name, staging);
  if (!pin || !latest || latest === pin.version) return null;
  return `⬆ ${pin.name}@${latest} is out (pinned ${pin.version}); bump it in the registry to upgrade.`;
}

// Staging folders hold vendor content and the installer's fake HOME, where an
// installer may have saved its token. They are removed on every exit path,
// including errors and Ctrl-C.
const cleanups = new Set<() => void>();
process.on("exit", () => cleanups.forEach((f) => f()));
process.on("SIGINT", () => process.exit(130));

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
function fetchSet(ctx: Ctx, id: string, set: ManagedSet, staging: string, interactive: boolean) {
  const vendorDir = acquire(id, set, staging, { interactive });
  return () =>
    plan({
      paths: ctx.paths,
      setId: id,
      set: getSet(ctx.registry, id) as ManagedSet,
      state: readState(ctx.paths.stateDir),
      lock: readSkillLock(ctx.paths.skillLock),
      pluginSkills: pluginSkillNames(path.dirname(ctx.paths.pluginCache)),
      vendorDir,
      staging,
      links: linkDirsFor(ctx.paths, getSet(ctx.registry, id)),
      captured: interactive,
    });
}

/** Without a terminal there is no one to confirm, so -y must say so up front. */
function needsYes(flags: Flags): string | null {
  if (flags.yes || flags.dryRun || isInteractive()) return null;
  return "No terminal to confirm on; pass -y to apply, or --dry-run to only see the plan.";
}

async function sync(ctx: Ctx, id: string, flags: Flags): Promise<number> {
  const any = getSet(ctx.registry, id);
  if (!isManaged(any)) return syncCli(ctx, id, flags);
  const set = any;
  const interactive = flags.interactive && set.type === "installer";
  if (interactive && !isInteractive()) throw new Error("Interactive install needs a terminal; pass -y to install everything.");
  if (!interactive && !runsUnattended(set)) {
    console.log(`■ ${id}: only runs interactively; skipped. Run: skl update ${id} -i`);
    return 0;
  }
  const refuse = needsYes(flags);
  if (refuse) throw new Error(refuse);
  // Collision answers go into a draft and reach the registry file only when
  // the plan is applied, never on --dry-run or a "no".
  const draft: Ctx = { ...ctx, registry: structuredClone(ctx.registry), saveRegistry: () => {} };
  let resolved = false;
  const staging = stagingFor(ctx, id);
  try {
    const replan = fetchSet(draft, id, set, staging, interactive);
    let p = replan();
    while (p.collisions.length) {
      if (flags.yes || !isInteractive()) {
        report(p);
        printResolveHints(p);
        return 1;
      }
      for (const c of p.collisions) await resolveInteractively(draft, id, c);
      resolved = true;
      p = replan();
    }
    report(p);
    const hint = versionHint(set, staging);
    if (hint) console.log(`  ${hint}`);
    if (p.errors.length) return 1;
    const work = p.skills.some((s) => s.write) || p.removed.length > 0 || p.relink || p.captured !== undefined || resolved;
    if (!work) {
      console.log("  up to date.");
      return 0;
    }
    if (flags.dryRun) {
      console.log(`  dry run: nothing installed${resolved ? ", collision answers not saved" : ""}.`);
      return 0;
    }
    if (!flags.yes && !(await confirm("Apply?"))) return 0;
    const trash = apply(ctx.paths, p, readState(ctx.paths.stateDir), draft.registry, ctx.saveRegistry);
    if (resolved) ctx.saveRegistry(draft.registry);
    ctx.registry = draft.registry;
    console.log(`  applied.${fs.existsSync(trash) ? ` Previous versions: ${trash}` : ""}`);
    return 0;
  } catch (e) {
    console.error(`✗ ${id}: ${(e as Error).message}`);
    return 1;
  } finally {
    dropStaging(staging);
  }
}

async function syncCli(ctx: Ctx, id: string, flags: Flags): Promise<number> {
  const refuse = needsYes(flags);
  if (refuse) throw new Error(refuse);
  const draft: Ctx = { ...ctx, registry: structuredClone(ctx.registry), saveRegistry: () => {} };
  let resolved = false;
  try {
    const set0 = getSet(draft.registry, id) as SkillsCliSet;
    const available = listSource(ctx.paths, set0.source);
    const replan = () =>
      planCli({
        paths: ctx.paths,
        setId: id,
        set: getSet(draft.registry, id) as SkillsCliSet,
        available,
        lock: readSkillLock(ctx.paths.skillLock),
        state: readState(ctx.paths.stateDir),
      });
    let p = replan();
    while (p.collisions.length) {
      if (flags.yes || !isInteractive()) {
        reportCli(p, []);
        console.log("  Resolve, then run update again:");
        for (const c of p.collisions) {
          console.log(`    skl resolve ${id} ${c.name} --exclude`);
          const holder = /^set "(.+)"$/.exec(c.holder)?.[1];
          if (holder) console.log(`    skl resolve ${holder} ${c.name} --rename <name>   (then: skl update ${holder})`);
        }
        return 1;
      }
      for (const c of p.collisions) {
        log.warn(`Name collision: ${c.name}\nalready held by ${c.holder}\nincoming from "${id}" (npx skills; its names cannot be changed)`);
        const action = await choose(`What should happen to ${c.name}?`, [
          { value: "exclude", label: `Don't install it from "${id}"` },
          { value: "abort", label: "Stop", hint: /^set "/.test(c.holder) ? "then rename the other side with skl resolve" : undefined },
        ]);
        if (action === "abort") throw new Cancelled();
        setResolution(draft, id, c.name, { exclude: true });
      }
      resolved = true;
      p = replan();
    }
    const lock = readSkillLock(ctx.paths.skillLock);
    const up = upstreamChanges(lock, p.update);
    p.update = [...up.changed, ...up.unknown];
    reportCli(p, up.unknown);
    const links = linkDirsFor(ctx.paths, getSet(draft.registry, id));
    if (!p.add.length && !p.update.length && !p.remove.length && !resolved) {
      console.log("  up to date.");
      return 0;
    }
    if (flags.dryRun) {
      console.log(`  dry run: nothing installed${resolved ? ", collision answers not saved" : ""}.`);
      return 0;
    }
    if (!flags.yes && !(await confirm("Apply?"))) return 0;
    applyCli(ctx.paths, p, links);
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

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A list for one report line; long ones are cut to a few names and a count. */
function summarize(items: string[], max = 8): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

function reportCli(p: CliPlan, unknown: string[]): void {
  console.log(`\n■ ${p.set}  (npx skills · ${p.source})`);
  const line = (title: string, items: string[]) => {
    if (items.length) console.log(`  ${title.padEnd(11)}${summarize(items)}`);
  };
  line("new", p.add);
  line("changed", p.update.filter((n) => !unknown.includes(n)));
  line("can't tell", unknown);
  line("removed", p.remove);
  line("unselected", p.unselected);
  for (const c of p.collisions) console.log(`  ✗ ${c.name} collides with ${c.holder}`);
}

async function resolveInteractively(ctx: Ctx, id: string, c: Collision): Promise<void> {
  const set = getSet(ctx.registry, id) as ManagedSet;
  const prefixed = withPrefix(c.original, set.prefix ?? id);
  log.warn(`Name collision: ${c.name}\nalready held by ${c.holder}\nincoming from set "${id}"`);
  const action = await choose(`How should "${id}" install ${c.original}?`, [
    { value: "prefix", label: "Add a prefix", hint: isValidSkillName(prefixed) ? prefixed : undefined },
    { value: "rename", label: "Rename it" },
    { value: "exclude", label: "Don't install it" },
    { value: "abort", label: "Stop" },
    { value: "other", label: "Rename the other one", disabled: "skillport only renames skills it installs" },
  ]);
  if (action === "abort") throw new Cancelled();
  if (action === "exclude") return setResolution(ctx, id, c.original, { exclude: true });
  // The name is editable and validated; one that still collides is caught by
  // the replan that follows and asked about again.
  const to = await ask("New name", {
    initial: action === "prefix" && isValidSkillName(prefixed) ? prefixed : undefined,
    placeholder: c.original,
    validate: (v) =>
      !isValidSkillName(v) ? "Use a-z, 0-9 and single hyphens." : v === c.name ? "That is the colliding name." : undefined,
  });
  setResolution(ctx, id, c.original, { to, reason: `collides with ${c.holder}` });
}

type Resolution = { exclude: true } | { to: string; reason: string } | { undo: true };

function setResolution(ctx: Ctx, id: string, original: string, r: Resolution): void {
  const set = getSet(ctx.registry, id);
  if (!isManaged(set)) {
    // npx skills owns these names; skillport can only leave one out.
    if ("to" in r) throw new Error(`"${id}" is a skills-cli set; its names belong to npx skills. Use --exclude, or rename the other side.`);
    set.exclude = (set.exclude ?? []).filter((n) => n !== original);
    if ("exclude" in r) set.exclude.push(original);
    if (!set.exclude.length) delete set.exclude;
    ctx.saveRegistry(ctx.registry);
    return;
  }
  const at = new Date().toISOString().slice(0, 10);
  set.exclude = (set.exclude ?? []).filter((n) => n !== original);
  if (set.rename) delete set.rename[original];
  if ("exclude" in r) set.exclude.push(original);
  if ("to" in r) set.rename = { ...(set.rename ?? {}), [original]: { to: r.to, reason: r.reason, at } };
  if (!set.exclude.length) delete set.exclude;
  if (set.rename && !Object.keys(set.rename).length) delete set.rename;
  ctx.saveRegistry(ctx.registry);
}

function resolveCmd(ctx: Ctx, rest: string[]): number {
  const [id, skill, mode, value] = rest;
  const set = getSet(ctx.registry, id);
  if (!skill || !mode) throw new Error(USAGE);
  if (mode === "--exclude") setResolution(ctx, id, skill, { exclude: true });
  else if (mode === "--undo") setResolution(ctx, id, skill, { undo: true });
  else if (mode === "--prefix" || mode === "--rename") {
    const prefix = value ?? (isManaged(set) ? (set.prefix ?? id) : id);
    const to = mode === "--prefix" ? withPrefix(skill, prefix) : value;
    if (!to || !isValidSkillName(to)) throw new Error(`"${to ?? ""}" is not a valid skill name.`);
    setResolution(ctx, id, skill, { to, reason: "resolved by hand" });
  } else throw new Error(USAGE);
  console.log(`Recorded in ${ctx.paths.registry}. Run: skl update ${id}`);
  return 0;
}

function printResolveHints(p: Plan): void {
  console.log("  Resolve, then run update again:");
  for (const c of p.collisions) {
    console.log(`    skl resolve ${p.set} ${c.original} --prefix`);
    console.log(`    skl resolve ${p.set} ${c.original} --rename <name>`);
    console.log(`    skl resolve ${p.set} ${c.original} --exclude`);
  }
}

function report(p: Plan): void {
  console.log(`\n■ ${p.set}`);
  const label = (s: Plan["skills"][number]) => (s.original === s.name ? s.name : `${s.original} → ${s.name}`);
  const by = (u: string) => p.skills.filter((s) => s.upstream === u).map(label);
  const line = (title: string, items: string[]) => {
    if (items.length) console.log(`  ${title.padEnd(11)}${summarize(items)}`);
  };
  line("new", by("new"));
  line("changed", by("changed"));
  line("removed", p.removed);
  line("unselected", p.unselected);
  const same = by("unchanged").length;
  if (same) console.log(`  ${"unchanged".padEnd(11)}${count(same, "skill")}`);
  line("local edits", p.skills.filter((s) => s.localEdits && s.write).map((s) => s.name));
  for (const { file, change } of p.rewrites) {
    console.log(`  rewrite    ${file}:${change.line} \`${change.from}\` → \`${change.to}\``);
  }
  for (const { file, change } of p.keptAsCode) {
    console.log(`  kept       ${file}:${change.line} \`${change.from}\` reads as code; review`);
  }
  for (const c of p.collisions) console.log(`  ✗ ${c.name} collides with ${c.holder}`);
  for (const w of p.warnings) console.log(`  ⚠ ${w}`);
  for (const e of p.errors) console.log(`  ✗ ${e}`);
}

async function check(ctx: Ctx, ids: string[]): Promise<number> {
  let failed = 0;
  for (const id of ids.length ? ids : Object.keys(ctx.registry.sets)) {
    const set = getSet(ctx.registry, id);
    try {
      if (!isManaged(set)) {
        checkCli(ctx, id, set);
        continue;
      }
      if (!runsUnattended(set)) {
        console.log(`■ ${id}: only runs interactively; check skipped. Run: skl update ${id} -i`);
        continue;
      }
      const staging = stagingFor(ctx, id);
      try {
        if (set.type === "npm") {
          // A pinned package never changes; only a newer version can.
          const hint = versionHint(set, staging);
          console.log(`\n■ ${id}`);
          console.log(hint ? `  ${hint}` : `  up to date (${set.package} is the latest).`);
          continue;
        }
        report(fetchSet(ctx, id, set, staging, false)());
        const hint = versionHint(set, staging);
        if (hint) console.log(`  ${hint}`);
      } finally {
        dropStaging(staging);
      }
    } catch (e) {
      failed++;
      console.error(`✗ ${id}: ${(e as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

function checkCli(ctx: Ctx, id: string, set: SkillsCliSet): void {
  const lock = readSkillLock(ctx.paths.skillLock);
  const p = planCli({
    paths: ctx.paths,
    setId: id,
    set,
    available: listSource(ctx.paths, set.source),
    lock,
    state: readState(ctx.paths.stateDir),
  });
  const up = upstreamChanges(lock, p.update);
  p.update = [...up.changed, ...up.unknown];
  reportCli(p, up.unknown);
  if (!p.add.length && !p.update.length && !p.remove.length) console.log("  up to date.");
}

function status(ctx: Ctx): number {
  const state = readState(ctx.paths.stateDir);
  const lock = readSkillLock(ctx.paths.skillLock);
  const pad = "".padEnd(15);
  let problems = 0;
  for (const [id, set] of Object.entries(ctx.registry.sets)) {
    if (!isManaged(set)) {
      const mine = Object.values(lock).filter((e) => e.source === set.source).length;
      console.log(`${id.padEnd(15)}${"skills-cli".padEnd(13)}${count(mine, "skill").padEnd(10)}${set.source}`);
      continue;
    }
    const st = state.sets[id];
    const n = Object.keys(st?.skills ?? {}).length;
    const when = st ? `${count(n, "skill").padEnd(10)}synced ${st.syncedAt.slice(0, 16).replace("T", " ")}` : "not installed";
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
  if (!Object.keys(ctx.registry.sets).length) console.log(`No sets registered. Edit ${ctx.paths.registry}.`);
  if (problems) console.log(`\n${count(problems, "problem")} found.`);
  return 0;
}

function diff(ctx: Ctx, id: string | undefined, skill: string | undefined): number {
  if (!id || !skill) throw new Error(USAGE);
  const set = getSet(ctx.registry, id);
  if (!isManaged(set)) throw new Error(`"${id}" is installed by npx skills; compare upstream on its source instead.`);
  const staging = stagingFor(ctx, id);
  try {
    const s = fetchSet(ctx, id, set, staging, false)().skills.find((x) => x.name === skill || x.original === skill);
    if (!s) throw new Error(`"${skill}" is not in set "${id}".`);
    spawnSync("diff", ["-ru", path.join(ctx.paths.skillsDir, s.name), s.staged], { stdio: "inherit" });
    return 0;
  } finally {
    dropStaging(staging);
  }
}

async function remove(ctx: Ctx, id: string | undefined, flags: Flags): Promise<number> {
  const set = getSet(ctx.registry, id);
  const state = readState(ctx.paths.stateDir);
  const names = isManaged(set)
    ? Object.keys(state.sets[id!]?.skills ?? {})
    : lockedFor(readSkillLock(ctx.paths.skillLock), set.source);
  const how = isManaged(set) ? "moved to trash, links removed" : "removed through npx skills";
  console.log(`Remove set "${id}": ${count(names.length, "skill")} ${how}; the set is unregistered.`);
  if (flags.dryRun) {
    console.log("dry run: nothing removed.");
    return 0;
  }
  const refuse = needsYes(flags);
  if (refuse) throw new Error(refuse);
  if (!flags.yes && !(await confirm("Continue?"))) return 0;
  if (isManaged(set)) removeManaged(ctx.paths, id!, state);
  else if (names.length) applyCli(ctx.paths, { set: id!, source: set.source, add: [], update: [], remove: names, unselected: [], collisions: [] }, []);
  delete ctx.registry.sets[id!];
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
