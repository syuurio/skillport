import type { Flags } from "./context.ts";
import { chooseMany, confirm, isInteractive, log } from "./prompt.ts";

// Which of a source's skills a sync installs. The registry only names the
// source; what you chose lives in state: the skills installed, and the ones
// you were offered and declined. Skills the vendor adds later are listed and
// offered, never installed on their own.

export interface Selection {
  /** Vendor names to install. */
  want: string[];
  /** Vendor names declined, to record in state. */
  declined: string[];
  /** Offered for the first time but not decided (no terminal, or -y). */
  pending: string[];
}

export interface SelectionInput {
  setId: string;
  /** Every vendor name the source ships, before `exclude`. */
  available: string[];
  exclude: string[];
  /** Vendor names installed now; null when the set was never installed. */
  installed: string[] | null;
  declined: string[];
  flags: Flags;
  /** Choose again from everything (--pick), not only from what is new. */
  pick: boolean;
}

/** The decision without prompts: what is installed stays, what is new waits. */
export function settled(input: SelectionInput): Selection {
  const offered = input.available.filter((n) => !input.exclude.includes(n));
  const installed = offered.filter((n) => input.installed?.includes(n));
  const declined = input.declined.filter((n) => offered.includes(n));
  const fresh = offered.filter((n) => !installed.includes(n) && !declined.includes(n));
  // First install with -y: "yes" to everything, as the flag says.
  if (input.installed === null && input.flags.yes) return { want: offered, declined: [], pending: [] };
  return { want: installed, declined, pending: fresh };
}

/** Ask on a terminal: about new skills, or (pick) about all of them. */
export async function select(input: SelectionInput): Promise<Selection> {
  const base = settled(input);
  const canAsk = isInteractive() && !input.flags.yes;
  if (!canAsk) return base;
  const offered = input.available.filter((n) => !input.exclude.includes(n));
  if (input.pick) {
    const picked = await chooseMany(
      `Which skills from "${input.setId}"? (space to toggle, a for all)`,
      offered.map((n) => ({ value: n, label: n })),
      base.want,
    );
    return { want: picked, declined: offered.filter((n) => !picked.includes(n)), pending: [] };
  }
  if (!base.pending.length) return base;
  const first = input.installed === null;
  log.info(`${first ? "Skills" : "New skills"} in "${input.setId}" (${base.pending.length}):\n${base.pending.join(", ")}`);
  if (!(await confirm(`Install any of them?`, true))) {
    return { ...base, declined: [...base.declined, ...base.pending], pending: [] };
  }
  const picked = await chooseMany(
    "Which ones? (space to toggle, a for all, enter to confirm)",
    base.pending.map((n) => ({ value: n, label: n })),
    [],
    true,
  );
  return {
    want: [...base.want, ...picked],
    declined: [...base.declined, ...base.pending.filter((n) => !picked.includes(n))],
    pending: [],
  };
}
