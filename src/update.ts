import path from "node:path";
import { type FetchOptions, type Fetched, fetchSource } from "./adapters/index.ts";
import { skillFlags } from "./check.ts";
import type { Lock } from "./lock.ts";
import { type Manifest, type SkillId, type Source, type SourceId, splitSkillId, writeManifest } from "./manifest.ts";
import type { Paths } from "./registry.ts";
import { type Status, writeStatus } from "./status.ts";
import { type SyncChange, describeSync, sync } from "./sync.ts";

// `skl update`: fetch, show the plan, ask, apply. Everything that needs the
// network happens before the first write; the write is one sync. See SPEC §11.

export interface UpdateFlags {
  yes: boolean;
  dryRun: boolean;
  /** Choose again from every skill of each source. */
  pick: boolean;
  /** Run installers that only work with you at the terminal. */
  interactive: boolean;
  discardEdits: boolean;
}

/** The prompts update uses; replaced in tests. */
export interface UpdateIO {
  canAsk: boolean;
  confirm(question: string): Promise<boolean>;
  chooseMany(question: string, options: string[], initial: string[]): Promise<string[]>;
  print(line: string): void;
}

type Fetch = (id: SourceId, source: Source, opts: FetchOptions) => Fetched;

const short = (v: string) => (/^[0-9a-f]{40}$/.test(v) ? v.slice(0, 7) : v);

function header(sid: SourceId, lock: Lock, fetched: Fetched | undefined): string {
  const from = lock.sources[sid]?.resolved;
  return fetched && from && fetched.resolved !== from ? `${sid}  ${short(from)} → ${short(fetched.resolved)}` : sid;
}

/** The plan as SPEC §11 shows it: changes per source, then what is held back. */
function planLines(sources: SourceId[], lock: Lock, fetched: Map<SourceId, Fetched>, changes: SyncChange[]): string[] {
  const lines: string[] = [];
  const of = (sid: SourceId) => changes.filter((c) => splitSkillId(c.id).source === sid);
  for (const sid of sources) {
    const mine = of(sid).filter((c) => c.kind !== "edited");
    if (!mine.length) continue;
    lines.push(header(sid, lock, fetched.get(sid)));
    for (const c of mine) {
      if (c.kind === "install") lines.push(`  ${c.replaced ? "replace" : "install"}   ${c.name}`);
      if (c.kind === "relink") lines.push(`  relink    ${c.name}`);
      if (c.kind === "remove") lines.push(`  remove    ${c.name}`);
    }
    const fresh = mine.filter((c) => c.kind === "offered").map((c) => splitSkillId(c.id).original);
    if (fresh.length) lines.push(`  new       ${fresh.join(", ")}`);
  }
  const held = changes.filter((c): c is Extract<SyncChange, { kind: "edited" }> => c.kind === "edited" && sources.includes(splitSkillId(c.id).source));
  if (held.length) {
    lines.push("", "Held back (not applied):");
    for (const c of held) {
      const { source, original } = splitSkillId(c.id);
      lines.push(
        `  edited    ${c.name.padEnd(18)} changed in place in ~/.agents/skills`,
        `            keep your edits:   skl edit ${source}/${original} --from-disk`,
        `            discard them:      skl update ${source} --discard-edits`,
      );
    }
  }
  return lines;
}

export async function update(
  paths: Paths,
  manifest: Manifest,
  lock: Lock,
  status: Status | null,
  ids: string[],
  flags: UpdateFlags,
  io: UpdateIO,
  fetch: Fetch = fetchSource,
): Promise<number> {
  const unknown = ids.filter((id) => !manifest.sources[id as SourceId]);
  if (unknown.length) throw new Error(`Unknown source ${unknown.join(", ")}. Known: ${Object.keys(manifest.sources).join(", ")}`);
  const sources = (ids.length ? ids : Object.keys(manifest.sources)) as SourceId[];
  const next: Manifest = structuredClone(manifest);

  // The network part, per source; one failing does not stop the others.
  const fetched = new Map<SourceId, Fetched>();
  let failed = 0;
  for (const sid of sources) {
    const source = manifest.sources[sid];
    if (source.type === "local") continue; // sync reads it itself
    if (source.type === "installer" && source.unattended === undefined && !flags.interactive) {
      io.print(`${sid}  skipped: its installer only runs with you at the terminal; skl update ${sid} -i`);
      continue;
    }
    const interactive = source.type === "installer" && flags.interactive;
    try {
      fetched.set(sid, fetch(sid, source, { staging: path.join(paths.sklDir, "fetch", sid), interactive, home: paths.home, sklDir: paths.sklDir }));
    } catch (e) {
      failed++;
      io.print(`${sid}  failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const updating = sources.filter((sid) => fetched.has(sid) || manifest.sources[sid].type === "local");

  if (flags.pick) {
    if (!io.canAsk) throw new Error("--pick asks which skills to keep; run it at a terminal");
    for (const sid of updating) {
      const all = fetched.get(sid)?.skills.map((s) => s.original as string) ?? [];
      if (!all.length) continue;
      const installed = all.filter((o) => lock.skills[`${sid}/${o}` as SkillId]);
      next.sources[sid].pick = await io.chooseMany(`Which skills from "${sid}"?`, all, installed);
    }
  }

  const opts = { fetched, discardEdits: flags.discardEdits };
  const planned = sync(paths, next, lock, { ...opts, dryRun: true }).filter((c) => updating.includes(splitSkillId(c.id).source));
  const lines = planLines(updating, lock, fetched, planned);
  const work = planned.filter((c) => c.kind === "install" || c.kind === "relink" || c.kind === "remove");
  const offered = planned.filter((c) => c.kind === "offered").map((c) => c.id);
  if (!work.length && !offered.length) {
    io.print([...lines, ...(lines.length ? [""] : []), "up to date"].join("\n").trimStart());
    return failed ? 1 : 0;
  }
  io.print(lines.join("\n"));
  if (flags.dryRun) {
    io.print("\ndry run: nothing changed.");
    return failed ? 1 : 0;
  }

  // New skills are picked here, before Apply; unchecked ones count as seen.
  const asking = io.canAsk && !flags.yes;
  const accept = new Set<SkillId>();
  if (asking) {
    for (const sid of updating) {
      const fresh = offered.filter((id) => splitSkillId(id).source === sid).map((id) => splitSkillId(id).original as string);
      if (!fresh.length) continue;
      for (const o of await io.chooseMany(`New skills in ${sid}. Install any?`, fresh, [])) {
        accept.add(`${sid}/${o}` as SkillId);
        const source = next.sources[sid];
        if (source.pick) source.pick = [...source.pick, o];
      }
    }
  }
  if (!work.length && !accept.size) {
    // Nothing to install, but what you were just shown now counts as seen.
    if (asking) sync(paths, next, lock, { ...opts, offeredNow: true });
    return failed ? 1 : 0;
  }
  if (!flags.yes) {
    if (!io.canAsk) throw new Error("skl update needs -y without a terminal");
    if (!(await io.confirm("Apply?"))) return failed ? 1 : 0;
  }

  const applied = sync(paths, next, lock, { ...opts, accept, offeredNow: asking }).filter((c) => updating.includes(splitSkillId(c.id).source));
  if (JSON.stringify(next) !== JSON.stringify(manifest)) writeManifest(paths.manifest, next);
  const shown = describeSync(applied.filter((c) => c.kind !== "edited" && c.kind !== "offered"));
  if (shown.length) io.print(["", ...shown].join("\n"));

  // What check said is now stale for the sources just updated.
  const now = new Date().toISOString();
  const left = new Set(applied.filter((c) => c.kind === "offered").map((c) => splitSkillId(c.id).source));
  const sourcesStatus = { ...(status?.sources ?? {}) };
  for (const sid of updating) if (!left.has(sid)) sourcesStatus[sid] = { checkedAt: now, state: "up-to-date" };
  writeStatus(paths.statusFile, { checkedAt: status?.checkedAt ?? now, sources: sourcesStatus, skills: skillFlags(paths, lock) });
  return failed ? 1 : 0;
}
