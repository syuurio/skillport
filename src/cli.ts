import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { acquire, latestVersion, pinnedPackage } from "./acquire.ts";
import { apply, removeManaged } from "./apply.ts";
import { storeSecret } from "./keychain.ts";
import { type Collision, type Plan, plan } from "./plan.ts";
import { pluginSkillNames } from "./plugins.ts";
import { ask, choose, confirm, isInteractive } from "./prompt.ts";
import {
  type ManagedSet,
  type Paths,
  type Registry,
  defaultPaths,
  getSet,
  isManaged,
  readRegistry,
  writeRegistry,
} from "./registry.ts";
import { readSkillLock, readState } from "./state.ts";
import { isValidSkillName, withPrefix } from "./transform.ts";
import { treeHash } from "./treehash.ts";

const USAGE = `skillport — one place for skills that vendor installers scatter

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
  switch (cmd) {
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

function managed(ctx: Ctx, id: string): ManagedSet | null {
  const set = getSet(ctx.registry, id);
  if (isManaged(set)) return set;
  console.log(`■ ${id}: skills-cli sets are not supported yet (milestone M2).`);
  return null;
}

/** Fetch a set into staging; `replan` re-reads the registry each time. */
function fetchSet(ctx: Ctx, id: string, set: ManagedSet, interactive: boolean) {
  const staging = path.join(ctx.paths.stateDir, "staging", id);
  const vendorDir = acquire(id, set, staging, { interactive });
  const replan = () =>
    plan({
      paths: ctx.paths,
      setId: id,
      set: getSet(ctx.registry, id) as ManagedSet,
      state: readState(ctx.paths.stateDir),
      lock: readSkillLock(ctx.paths.skillLock),
      pluginSkills: pluginSkillNames(path.dirname(ctx.paths.pluginCache)),
      vendorDir,
      staging,
      captured: interactive,
    });
  return { staging, replan };
}

async function sync(ctx: Ctx, id: string, flags: Flags): Promise<number> {
  const set = managed(ctx, id);
  if (!set) return 0;
  const interactive = flags.interactive && set.type === "installer";
  if (interactive && !isInteractive()) throw new Error("Interactive install needs a terminal; pass -y to install everything.");
  let staging = "";
  try {
    const f = fetchSet(ctx, id, set, interactive);
    staging = f.staging;
    let p = f.replan();
    while (p.collisions.length) {
      if (flags.yes || !isInteractive()) {
        report(p);
        printResolveHints(p);
        return 1;
      }
      for (const c of p.collisions) await resolveInteractively(ctx, id, c);
      p = f.replan();
    }
    report(p);
    if (p.errors.length) return 1;
    const work = p.skills.some((s) => s.write) || p.removed.length > 0 || p.captured !== undefined;
    if (!work) {
      console.log("  up to date.");
      return 0;
    }
    if (flags.dryRun) {
      console.log("  dry run: nothing installed.");
      return 0;
    }
    if (!flags.yes && isInteractive() && !(await confirm("  Apply?"))) return 0;
    const trash = apply(ctx.paths, p, readState(ctx.paths.stateDir), ctx.registry, ctx.saveRegistry);
    console.log(`  applied.${fs.existsSync(trash) ? ` Previous versions: ${trash}` : ""}`);
    return 0;
  } catch (e) {
    console.error(`✗ ${id}: ${(e as Error).message}`);
    return 1;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function resolveInteractively(ctx: Ctx, id: string, c: Collision): Promise<void> {
  const set = getSet(ctx.registry, id) as ManagedSet;
  const prefixed = withPrefix(c.original, set.prefix ?? id);
  console.log(`\n⚠ Name collision: ${c.name}\n  already held by ${c.holder}\n  incoming from set "${id}"`);
  const action = await choose(`  How should "${id}" install ${c.original}?`, [
    { value: "prefix", label: `Add prefix   → ${prefixed}` },
    { value: "rename", label: "Rename       → choose a name" },
    { value: "exclude", label: "Exclude      → do not install it" },
    { value: "abort", label: "Abort" },
    { value: "other", label: "Rename the other side", disabled: "skillport only renames skills it installs" },
  ]);
  if (action === "abort") throw new Error("Aborted.");
  if (action === "exclude") return setResolution(ctx, id, c.original, { exclude: true });
  let to = prefixed;
  if (action === "rename") {
    for (;;) {
      to = await ask("  New name: ");
      if (isValidSkillName(to)) break;
      console.log("  Use a-z, 0-9 and single hyphens.");
    }
  }
  setResolution(ctx, id, c.original, { to, reason: `collides with ${c.holder}` });
}

type Resolution = { exclude: true } | { to: string; reason: string } | { undo: true };

function setResolution(ctx: Ctx, id: string, original: string, r: Resolution): void {
  const set = getSet(ctx.registry, id);
  if (!isManaged(set)) throw new Error(`"${id}" is a skills-cli set; its names belong to npx skills.`);
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
    if (items.length) console.log(`  ${title.padEnd(11)}${items.join(", ")}`);
  };
  line("new", by("new"));
  line("changed", by("changed"));
  line("removed", p.removed);
  line("unselected", p.unselected);
  const same = by("unchanged").length;
  if (same) console.log(`  ${"unchanged".padEnd(11)}${same} skill${same === 1 ? "" : "s"}`);
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
    const set = managed(ctx, id);
    if (!set) continue;
    let staging = "";
    try {
      const f = fetchSet(ctx, id, set, false);
      staging = f.staging;
      report(f.replan());
      const pin = pinnedPackage(set);
      const latest = pin && latestVersion(pin.name);
      if (pin && latest && latest !== pin.version) {
        console.log(`  ⬆ ${pin.name}@${latest} is out (pinned ${pin.version}); bump it in the registry to upgrade.`);
      }
    } catch (e) {
      failed++;
      console.error(`✗ ${id}: ${(e as Error).message}`);
    } finally {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  return failed ? 1 : 0;
}

function status(ctx: Ctx): number {
  const state = readState(ctx.paths.stateDir);
  const lock = readSkillLock(ctx.paths.skillLock);
  const pad = "".padEnd(15);
  let problems = 0;
  for (const [id, set] of Object.entries(ctx.registry.sets)) {
    if (!isManaged(set)) {
      const mine = Object.values(lock).filter((e) => e.source === set.source).length;
      console.log(`${id.padEnd(15)}${"skills-cli".padEnd(13)}${mine} skill${mine === 1 ? " " : "s"}   ${set.source}`);
      continue;
    }
    const st = state.sets[id];
    const n = Object.keys(st?.skills ?? {}).length;
    const when = st ? `${n} skill${n === 1 ? " " : "s"}   synced ${st.syncedAt.slice(0, 16).replace("T", " ")}` : "not installed";
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
  if (problems) console.log(`\n${problems} problem${problems === 1 ? "" : "s"} found.`);
  return 0;
}

function diff(ctx: Ctx, id: string | undefined, skill: string | undefined): number {
  if (!id || !skill) throw new Error(USAGE);
  const set = managed(ctx, id);
  if (!set) return 1;
  const f = fetchSet(ctx, id, set, false);
  try {
    const s = f.replan().skills.find((x) => x.name === skill || x.original === skill);
    if (!s) throw new Error(`"${skill}" is not in set "${id}".`);
    spawnSync("diff", ["-ru", path.join(ctx.paths.skillsDir, s.name), s.staged], { stdio: "inherit" });
    return 0;
  } finally {
    fs.rmSync(f.staging, { recursive: true, force: true });
  }
}

async function remove(ctx: Ctx, id: string | undefined, flags: Flags): Promise<number> {
  const set = getSet(ctx.registry, id);
  if (!isManaged(set)) {
    console.log(`"${id}" is a skills-cli set; removal is milestone M2.`);
    return 1;
  }
  const state = readState(ctx.paths.stateDir);
  const names = Object.keys(state.sets[id!]?.skills ?? {});
  console.log(`Remove set "${id}": ${names.length} skills go to trash, links are removed, the set is unregistered.`);
  if (!flags.yes && isInteractive() && !(await confirm("Continue?"))) return 0;
  removeManaged(ctx.paths, id!, state);
  delete ctx.registry.sets[id!];
  ctx.saveRegistry(ctx.registry);
  console.log("Done.");
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
