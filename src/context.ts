import { confirm, isInteractive } from "./prompt.ts";
import { type Paths, type Registry, type Resolution, applyResolution } from "./registry.ts";

// What every command works with, and the gates before a change.

export interface Flags {
  yes: boolean;
  interactive: boolean;
  dryRun: boolean;
  /** Choose again which skills to install, from everything offered (--pick). */
  pick?: boolean;
  /** Take over identical copies already on disk (skl adopt). */
  adopt?: boolean;
}

export interface Ctx {
  paths: Paths;
  registry: Registry;
  saveRegistry: (r: Registry) => void;
}

/** Throw the "pass -y" error when nobody can confirm. */
export function requireConfirmable(flags: Flags): void {
  const refuse = needsYes(flags);
  if (refuse) throw new Error(refuse);
}

/**
 * The gate before a change that is not a sync plan (registry edits, removal,
 * doctor fixes): --dry-run stops after the plan, no terminal needs -y, a
 * terminal asks. Returns whether to go ahead.
 */
export async function confirmChange(flags: Flags, question: string, dryRunNote: string): Promise<boolean> {
  if (flags.dryRun) {
    console.log(dryRunNote);
    return false;
  }
  requireConfirmable(flags);
  return flags.yes || (await confirm(question));
}

/** Without a terminal there is no one to confirm, so -y must say so up front. */
export function needsYes(flags: Flags): string | null {
  if (flags.yes || flags.dryRun || isInteractive()) return null;
  return "No terminal to confirm on; pass -y to apply, or --dry-run to only see the plan.";
}

/**
 * The step between a plan and changing anything, shared by every set type:
 * nothing to do, a dry run, or a "no" all stop here.
 */
export async function confirmPlan(flags: Flags, work: boolean, resolved: boolean): Promise<boolean> {
  if (!work) {
    console.log("  up to date.");
    return false;
  }
  if (flags.dryRun) {
    console.log(`  dry run: nothing installed${resolved ? ", collision answers not saved" : ""}.`);
    return false;
  }
  return flags.yes || (await confirm("Apply?"));
}

export function setResolution(ctx: Ctx, id: string, original: string, r: Resolution): void {
  applyResolution(ctx.registry, id, original, r);
  ctx.saveRegistry(ctx.registry);
}

/** A copy of the context whose registry edits stay in memory until saved. */
export function draftOf(ctx: Ctx): Ctx {
  return { ...ctx, registry: structuredClone(ctx.registry), saveRegistry: () => {} };
}
