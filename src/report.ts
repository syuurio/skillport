import type { HolderKind, Plan } from "./plan.ts";
import type { CliPlan } from "./skillscli.ts";
import type { Paths } from "./registry.ts";
import { vendorName } from "./state.ts";

// Printing plans and hints.

/** A path shown with ~ for your home folder. */
export const home = (p: string) => p.replace(`${process.env.SKILLPORT_HOME ?? process.env.HOME}/`, "~/");

export const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One report line: a title and its items, skipped when there are none. */
export function printItems(title: string, items: string[]): void {
  if (items.length) console.log(`  ${title.padEnd(11)}${summarize(items)}`);
}

/** A list for one report line; long ones are cut to a few names and a count. */
export function summarize(items: string[], max = 8): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

export function reportCli(p: CliPlan, unknown: string[]): void {
  console.log(`\n■ ${p.setId}  (npx skills · ${p.source})`);
  printItems("new", p.add);
  printItems("changed", p.update.filter((n) => !unknown.includes(n)));
  printItems("can't tell", unknown);
  printItems("removed", p.remove);
  printItems("unselected", p.unselected);
  printItems("left alone", p.others);
  for (const c of p.collisions) console.log(`  ✗ ${c.name} collides with ${c.holder}`);
  for (const w of p.warnings) console.log(`  ⚠ ${w}`);
}

/**
 * Commands that resolve each collision without a terminal. Only skillport
 * sets can rename their own skill; any set can be the "other side".
 */
export function printResolveHints(
  paths: Paths,
  setId: string,
  renamable: boolean,
  collisions: { name: string; original?: string; kind: HolderKind; holderId?: string }[],
): void {
  console.log("  Resolve, then run update again:");
  for (const c of collisions) {
    const name = c.original ?? c.name;
    if (renamable) {
      console.log(`    skl resolve ${setId} ${name} --prefix -y`);
      console.log(`    skl resolve ${setId} ${name} --rename <name> -y`);
    }
    console.log(`    skl resolve ${setId} ${name} --exclude -y`);
    if (c.kind === "set" && c.holderId) {
      // Rules are keyed by the vendor's name, which differs if that set renamed it already.
      const theirs = vendorName(paths.stateDir, c.holderId, c.name);
      console.log(`    skl resolve ${c.holderId} ${theirs} --rename <name> -y   (then: skl update ${c.holderId})`);
    }
  }
}

export function report(p: Plan): void {
  console.log(`\n■ ${p.setId}`);
  const label = (s: Plan["skills"][number]) => (s.original === s.name ? s.name : `${s.original} → ${s.name}`);
  const by = (u: string) => p.skills.filter((s) => s.upstream === u).map(label);
  printItems("new", by("new"));
  printItems("changed", by("changed"));
  printItems("removed", p.removed);
  printItems("unselected", p.unselected);
  printItems("adopt", p.adopted);
  printItems("clean up", p.strays.map(home));
  const same = by("unchanged").length;
  if (same) console.log(`  ${"unchanged".padEnd(11)}${count(same, "skill")}`);
  printItems("edits kept", p.skills.filter((s) => s.localEdits && !s.write).map((s) => s.name));
  printItems("edits replaced", [...p.skills.filter((s) => s.localEdits && s.write).map((s) => s.name), ...p.removedEdits]);
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
