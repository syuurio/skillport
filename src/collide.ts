import type { Ctx } from "./context.ts";
import { setResolution } from "./context.ts";
import type { Collision } from "./plan.ts";
import { Cancelled, ask, choose, log } from "./prompt.ts";
import { type ManagedSet, getSet, isManaged, prefixOf, runsUnattended } from "./registry.ts";
import { vendorName } from "./state.ts";
import { isValidSkillName, withPrefix } from "./transform.ts";

// Collision prompts. `update` runs another set's sync; it is passed in so this
// module does not import the command layer.
export type UpdateSet = (ctx: Ctx, id: string) => Promise<number>;

/** Why "rename the other side" is not offered for this collision, if it is not. */
export function otherSideBlocked(ctx: Ctx, c: Pick<Collision, "kind" | "holderId">, dryRun: boolean): string | undefined {
  const holder = c.kind === "set" && c.holderId ? ctx.registry.sets[c.holderId] : undefined;
  if (!holder) return "skillport only renames skills it installs";
  if (!isManaged(holder)) return "that set belongs to npx skills";
  if (!runsUnattended(holder)) return `set "${c.holderId}" only runs interactively`;
  if (dryRun) return "not in --dry-run: it updates the other set";
  return undefined;
}

/** Why a typed name cannot replace `colliding`, if it cannot. */
const nameProblem = (colliding: string) => (v: string) =>
  !isValidSkillName(v) ? "Use a-z, 0-9 and single hyphens." : v === colliding ? "That is the colliding name." : undefined;

/**
 * Free a name by renaming the skillport set that holds it: the rule is saved
 * to the registry right away (you chose it explicitly) and that set is
 * updated first. If you decline its update, the rule stays and the same
 * collision comes back.
 */
export async function renameOtherSide(ctx: Ctx, holderId: string, name: string, forSet: string, update: UpdateSet): Promise<void> {
  const holder = getSet(ctx.registry, holderId) as ManagedSet;
  const theirs = vendorName(ctx.paths.stateDir, holderId, name);
  const to = await ask(`New name for ${holderId}'s ${theirs}`, {
    initial: withPrefix(theirs, prefixOf(holder, holderId)),
    validate: nameProblem(name),
  });
  setResolution(ctx, holderId, theirs, { to, reason: `made room for set "${forSet}"` });
  log.info(`Saved. Updating set "${holderId}" first so ${name} is free.`);
  const code = await update(ctx, holderId);
  if (code !== 0) log.warn(`Set "${holderId}" was not updated; ${name} is still taken.`);
}

/**
 * Ask how to resolve one collision. "prefix", "rename" and "exclude" change
 * this set's rule in the draft. "adopt" takes over an identical unowned
 * folder. "other" renames the holder's skill instead: the rule is saved to
 * the registry and the holder is updated right away, so its name is free.
 */
export async function resolveInteractively(
  ctx: Ctx,
  draft: Ctx,
  id: string,
  c: Collision,
  opts: { adopt: boolean; dryRun: boolean; update: UpdateSet },
): Promise<"draft" | "adopt" | "other"> {
  const set = getSet(draft.registry, id) as ManagedSet;
  const prefixed = withPrefix(c.original, prefixOf(set, id));
  const holder = c.kind === "set" && c.holderId ? ctx.registry.sets[c.holderId] : undefined;
  const otherBlocked = otherSideBlocked(ctx, c, opts.dryRun);
  log.warn(`Name collision: ${c.name}\nalready held by ${c.holder}\nincoming from set "${id}"`);
  const action = await choose(`How should "${id}" install ${c.original}?`, [
    { value: "prefix", label: "Add a prefix", hint: isValidSkillName(prefixed) ? prefixed : undefined },
    { value: "rename", label: "Rename it" },
    ...(c.kind === "unowned" && !opts.adopt
      ? [{ value: "adopt" as const, label: "Take over the existing folder", hint: "only if it matches this set's copy" }]
      : []),
    { value: "exclude", label: "Don't install it" },
    {
      value: "other",
      label: holder ? `Rename it in set "${c.holderId}" instead` : "Rename the other one",
      disabled: otherBlocked,
    },
    { value: "abort", label: "Stop" },
  ]);
  if (action === "abort") throw new Cancelled();
  if (action === "adopt") return "adopt";
  if (action === "exclude") {
    setResolution(draft, id, c.original, { exclude: true });
    return "draft";
  }
  const valid = nameProblem(c.name);
  if (action === "other" && c.holderId) {
    await renameOtherSide(ctx, c.holderId, c.name, id, opts.update);
    return "other";
  }
  // The name is editable and validated; one that still collides is caught by
  // the replan that follows and asked about again.
  const to = await ask("New name", {
    initial: action === "prefix" && isValidSkillName(prefixed) ? prefixed : undefined,
    placeholder: c.original,
    validate: valid,
  });
  setResolution(draft, id, c.original, { to, reason: `collides with ${c.holder}` });
  return "draft";
}

/**
 * A collision for a skills-cli set. Its names belong to npx skills, so the
 * choices are leaving the skill out here or renaming the skillport set that
 * holds the name.
 */
export async function resolveCliCollision(
  ctx: Ctx,
  draft: Ctx,
  id: string,
  c: Omit<Collision, "original">,
  opts: { dryRun: boolean; update: UpdateSet },
): Promise<"draft" | "other"> {
  log.warn(`Name collision: ${c.name}\nalready held by ${c.holder}\nincoming from "${id}" (npx skills; its names cannot be changed)`);
  const action = await choose(`What should happen to ${c.name}?`, [
    { value: "exclude", label: `Don't install it from "${id}"` },
    {
      value: "other",
      label: c.kind === "set" ? `Rename it in set "${c.holderId}" instead` : "Rename the other one",
      disabled: otherSideBlocked(ctx, c, opts.dryRun),
    },
    { value: "abort", label: "Stop" },
  ]);
  if (action === "abort") throw new Cancelled();
  if (action === "other" && c.holderId) {
    await renameOtherSide(ctx, c.holderId, c.name, id, opts.update);
    return "other";
  }
  setResolution(draft, id, c.name, { exclude: true });
  return "draft";
}
