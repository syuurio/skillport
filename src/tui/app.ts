import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { type ReactNode, createElement as h, useRef, useState } from "react";
import { acquireLock } from "../apply.ts";
import { check, realNet } from "../check.ts";
import { diff } from "../diff.ts";
import { storeSecretValue } from "../keychain.ts";
import { type Lock, readLock } from "../lock.ts";
import { type Manifest, type SourceId, readManifest } from "../manifest.ts";
import { Cancelled } from "../prompt.ts";
import { type Paths, withLinkTargets } from "../registry.ts";
import { type Status, readStatus, writeStatus } from "../status.ts";
import { type Fetch, type UpdateIO, fetchSources, update } from "../update.ts";
import { type Pane, type SkillRow, type SourceRow, type Tone, LIST_HINTS, headerRight, listAction, skillRows, sourceRows, sourceTitle, viewAction } from "./model.ts";

// `skl` on a terminal. Every action calls the same check, diff and update as
// the CLI; the TUI only collects the answers update asks for (SPEC §12).

interface Data {
  paths: Paths;
  manifest: Manifest;
  lock: Lock;
  status: Status | null;
}

function load(base: Paths): Data {
  const manifest = readManifest(base.manifest);
  const paths = withLinkTargets(base, manifest, base.manifest);
  return { paths, manifest, lock: readLock(paths.lockFile), status: readStatus(paths.statusFile) };
}

interface Choice {
  source: SourceId | undefined;
  question: string;
  options: string[];
  picked: string[];
  cursor: number;
}

export type View =
  | { kind: "list" }
  | { kind: "busy"; text: string }
  | { kind: "lines"; title: string; lines: string[]; scroll: number }
  | { kind: "plan"; title: string; lines: string[]; scroll: number; phase: "running" | "choose" | "confirm" | "done"; choice: Choice | null }
  | { kind: "token"; id: SourceId; value: string };

const COLORS: Record<Tone, string | undefined> = { warn: "yellow", ok: "green", bad: "red", dim: "gray" };

/** Lets Ink paint before a call that blocks the event loop (fetches run synchronously). */
const painted = () => new Promise((r) => setTimeout(r, 30));

async function locked<T>(paths: Paths, fn: () => T | Promise<T>): Promise<T> {
  const release = acquireLock(paths.sklDir);
  try {
    return await fn();
  } finally {
    release();
    fs.rmSync(path.join(paths.sklDir, "fetch"), { recursive: true, force: true });
  }
}

const interactiveOnly = (d: Data, id: SourceId) => {
  const s = d.manifest.sources[id];
  return s.type === "installer" && s.unattended === undefined;
};

export interface Frame {
  data: Data;
  rows: SourceRow[];
  sel: number;
  pane: Pane;
  skills: SkillRow[];
  skillSel: number;
  picks: Record<string, string[]>;
  view: View;
  message: string;
  columns: number;
  height: number;
}

/** One frame of the TUI; pure, so tests render it with renderToString. */
export function Screen(f: Frame): ReactNode {
  const id = f.rows[f.sel]?.id;
  const left = h(
    Box,
    { flexDirection: "column", borderStyle: "single", width: Math.min(40, Math.floor(f.columns * 0.42)), flexShrink: 0, paddingX: 1 },
    h(Text, { bold: true }, "Sources"),
    ...f.rows.map((r, i) =>
      h(
        Box,
        { key: r.id, justifyContent: "space-between" },
        h(Box, { flexShrink: 0, marginRight: 1 }, h(Text, { inverse: i === f.sel && f.pane === "sources" && f.view.kind === "list" }, h(Text, { color: COLORS[r.tone] }, r.mark), ` ${r.id}`)),
        h(Text, { color: COLORS[r.tone], wrap: "truncate" }, r.state),
      ),
    ),
  );
  const right = h(Box, { flexDirection: "column", borderStyle: "single", flexGrow: 1, flexShrink: 1, minWidth: 0, paddingX: 1 }, ...rightPane(f, id));
  const hints =
    f.view.kind === "list"
      ? LIST_HINTS
      : f.view.kind === "plan"
        ? { running: "working…", choose: "↑↓ move  space toggle  y apply  Esc cancel", confirm: "y apply  Esc cancel", done: "↑↓ scroll  Esc back" }[f.view.phase]
        : f.view.kind === "token"
          ? "type the token  Enter save  Esc cancel"
          : f.view.kind === "lines"
            ? "↑↓ scroll  Esc back"
            : "";
  return h(
    Box,
    { flexDirection: "column", width: f.columns },
    h(Box, { justifyContent: "space-between", paddingX: 1 }, h(Text, { bold: true }, "skillport"), h(Text, { color: "gray" }, headerRight(f.data.status))),
    h(Box, { flexDirection: "row" }, left, right),
    h(Text, { color: "gray" }, ` ${hints}`),
    f.message ? h(Text, { color: "cyan" }, ` ${f.message}`) : null,
  );
}

function window<T>(lines: T[], scroll: number, height: number): T[] {
  return lines.slice(scroll, scroll + height);
}

function rightPane(f: Frame, id: SourceId | undefined): ReactNode[] {
  const v = f.view;
  if (v.kind === "busy") return [h(Text, { color: "yellow" }, v.text)];
  if (v.kind === "token") return [h(Text, { bold: true }, `Token for ${v.id}`), h(Text, null, `${"•".repeat(v.value.length)}▏`), h(Text, { color: "gray" }, "Stored in Keychain, never in the manifest.")];
  if (v.kind === "lines") return [h(Text, { bold: true }, v.title), ...window(v.lines, v.scroll, f.height).map((l, i) => h(Text, { key: i, wrap: "truncate" }, l || " "))];
  if (v.kind === "plan") {
    const body = window(v.lines, v.scroll, f.height - (v.choice ? v.choice.options.length + 1 : 0)).map((l, i) => h(Text, { key: i, wrap: "truncate" }, l || " "));
    const choice = v.choice && v.phase === "choose" ? [h(Text, { bold: true }, v.choice.question), ...v.choice.options.map((o, i) => h(Text, { key: o, inverse: i === v.choice?.cursor }, `${v.choice?.picked.includes(o) ? "◼" : "◻"} ${o}`))] : [];
    const tail = v.phase === "confirm" ? [h(Text, { bold: true }, "Apply? (y / Esc)")] : v.phase === "done" ? [h(Text, { color: "green" }, "Done.")] : [];
    return [h(Text, { bold: true }, v.title), ...body, ...choice, ...tail];
  }
  if (!id) return [h(Text, { color: "gray" }, "No sources yet. Add one: skl add <id> --github <owner/repo>")];
  const picked = f.picks[id] ?? [];
  return [
    h(Text, { bold: true, wrap: "truncate" }, sourceTitle(f.data.manifest, id)),
    ...(f.skills.length ? [] : [h(Text, { color: "gray" }, "Nothing installed from this source.")]),
    ...window(f.skills, Math.max(0, f.skillSel - f.height + 1), f.height).map((s) =>
      h(
        Box,
        { key: s.original },
        h(Text, { inverse: f.pane === "skills" && f.skills[f.skillSel] === s, wrap: "truncate" }, `${s.isNew ? (picked.includes(s.original) ? "◼ " : "◻ ") : ""}${s.name}`.padEnd(26)),
        h(Text, { color: s.isNew ? "cyan" : s.note.includes("conflict") || s.note.includes("edited") ? "red" : "yellow", wrap: "truncate" }, ` ${s.note}`),
      ),
    ),
  ];
}

function App({ base }: { base: Paths }): ReactNode {
  const { exit, suspendTerminal } = useApp();
  const { columns, rows: termRows } = useWindowSize();
  const [data, setData] = useState(() => load(base));
  const [sel, setSel] = useState(0);
  const [pane, setPane] = useState<Pane>("sources");
  const [skillSel, setSkillSel] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [view, setView] = useState<View>({ kind: "list" });
  const [message, setMessage] = useState("");
  const pending = useRef<{ choose?: [(v: string[]) => void, (e: Error) => void]; confirm?: (v: boolean) => void; applied?: boolean }>({});

  const rows = sourceRows(data.manifest, data.status);
  const id = rows[sel]?.id;
  const skills = id ? skillRows(data.lock, data.status, id) : [];
  const height = Math.max(3, termRows - 7);
  const reload = () => setData(load(base));
  const fail = (title: string, e: unknown) =>
    setView(e instanceof Cancelled ? { kind: "lines", title, lines: ["Cancelled; nothing changed."], scroll: 0 } : { kind: "lines", title, lines: (e as Error).message.split("\n"), scroll: 0 });
  const setPlan = (fn: (v: Extract<View, { kind: "plan" }>) => View) => setView((v) => (v.kind === "plan" ? fn(v) : v));

  async function runUpdate(ids: SourceId[], title: string) {
    const d = load(base);
    let fetch: Fetch | undefined;
    if (ids.length === 1 && interactiveOnly(d, ids[0])) {
      // This installer needs you: it gets the terminal, the TUI waits.
      const out: string[] = [];
      let fetched = new Map();
      await suspendTerminal(async () => {
        fetched = fetchSources(d.paths, d.manifest, ids, true, (l) => out.push(l)).fetched;
      });
      if (!fetched.has(ids[0])) return setView({ kind: "lines", title, lines: out, scroll: 0 });
      fetch = (sid) => fetched.get(sid);
    }
    pending.current = {};
    setView({ kind: "plan", title, lines: ["Fetching…"], scroll: 0, phase: "running", choice: null });
    await painted();
    const io: UpdateIO = {
      canAsk: true,
      print: (line) => setPlan((v) => ({ ...v, lines: [...v.lines.filter((l) => l !== "Fetching…"), ...line.split("\n")] })),
      chooseMany: (question, options, initial, source) =>
        new Promise((resolve, reject) => {
          pending.current.choose = [resolve, reject];
          const remembered = source ? (picks[source] ?? []) : [];
          setPlan((v) => ({ ...v, phase: "choose", choice: { source, question, options, picked: [...new Set([...initial, ...remembered])].filter((o) => options.includes(o)), cursor: 0 } }));
        }),
      confirm: () => {
        if (pending.current.applied) return Promise.resolve(true);
        return new Promise((resolve) => {
          pending.current.confirm = resolve;
          setPlan((v) => ({ ...v, phase: "confirm" }));
        });
      },
    };
    try {
      await locked(d.paths, () => update(d.paths, d.manifest, d.lock, d.status, ids, { yes: false, dryRun: false, pick: false, interactive: Boolean(fetch), discardEdits: false }, io, fetch));
      setPlan((v) => ({ ...v, phase: "done", choice: null }));
    } catch (e) {
      fail(title, e);
    }
    reload();
  }

  async function act(fn: () => Promise<void>) {
    setMessage("");
    try {
      await fn();
    } catch (e) {
      fail("Error", e);
    }
  }

  useInput((input, key) => {
    if (view.kind === "busy" || (view.kind === "plan" && view.phase === "running")) return;
    if (view.kind === "token") {
      if (key.escape) return setView({ kind: "list" });
      if (key.backspace || key.delete) return setView({ ...view, value: view.value.slice(0, -1) });
      if (key.return) {
        const tokenFor = view.id;
        return void act(async () => {
          storeSecretValue(tokenFor, view.value);
          setView({ kind: "busy", text: `Stored. Checking ${tokenFor}…` });
          await painted();
          await recheck([tokenFor]);
          setMessage(`Stored the token for ${tokenFor}.`);
        });
      }
      if (input && !key.ctrl && !key.meta) setView({ ...view, value: view.value + input });
      return;
    }
    if (view.kind !== "list") return onView(input, key);
    const a = listAction(input, key);
    if (!a || !id) return a?.kind === "quit" ? exit() : undefined;
    switch (a.kind) {
      case "move":
        if (pane === "sources") {
          setSel((s) => Math.min(rows.length - 1, Math.max(0, s + a.by)));
          setSkillSel(0);
        } else setSkillSel((s) => Math.min(skills.length - 1, Math.max(0, s + a.by)));
        return;
      case "pane":
        return setPane(a.to === "skills" && !skills.length ? "sources" : a.to);
      case "quit":
        return exit();
      case "pick": {
        const s = skills[skillSel];
        if (pane !== "skills" || !s?.isNew) return setMessage("space picks a new skill: move to one with →");
        const now = picks[id] ?? [];
        return setPicks({ ...picks, [id]: now.includes(s.original) ? now.filter((o) => o !== s.original) : [...now, s.original] });
      }
      case "open": {
        const st = data.status?.sources[id];
        if (st?.state !== "updates" || !st.link) return setMessage("no compare link for this source");
        spawn(process.platform === "darwin" ? "open" : "xdg-open", [st.link], { detached: true, stdio: "ignore" }).unref();
        return setMessage(`opened ${st.link}`);
      }
      case "recheck":
        return void act(async () => {
          setView({ kind: "busy", text: "Checking every source…" });
          await painted();
          await recheck([]);
        });
      case "diff": {
        const s = pane === "skills" ? skills[skillSel] : undefined;
        if (s?.isNew) return setMessage("a new skill has nothing installed to diff; u installs it");
        if (interactiveOnly(data, id)) return setMessage(`this installer needs the terminal: skl diff ${id} -i`);
        const target = s ? `${id}/${s.original}` : id;
        return void act(async () => {
          setView({ kind: "busy", text: `Fetching ${id} for the diff…` });
          await painted();
          const d = load(base);
          const lines = await locked(d.paths, () => {
            const out: string[] = [];
            const { fetched } = fetchSources(d.paths, d.manifest, [id], false, (l) => out.push(l));
            return [...out, ...diff(d.paths, d.manifest, d.lock, target, fetched)];
          });
          setView({ kind: "lines", title: `diff ${target}`, lines: lines.flatMap((l) => l.split("\n")), scroll: 0 });
        });
      }
      case "update": {
        if (a.all) return void act(() => runUpdate([], "Update all sources"));
        const st = data.status?.sources[id];
        if (st?.state === "needs-token") return setView({ kind: "token", id, value: "" });
        if (st?.state === "blocked") {
          const lines = st.collisions.flatMap((c) => [`${c.name} is taken by ${c.with}`, `  Fix: set sources.${id}.prefix, or add sources.${id}.rename.<skill> in the manifest`]);
          return setView({ kind: "lines", title: `${id} is blocked`, lines, scroll: 0 });
        }
        return void act(() => runUpdate([id], `Update ${id}`));
      }
    }
  });

  async function recheck(ids: SourceId[]) {
    const d = load(base);
    const staging = path.join(d.paths.sklDir, "check");
    await locked(d.paths, () => {
      try {
        writeStatus(d.paths.statusFile, check(d.paths, d.manifest, d.lock, d.status, ids, realNet(staging)));
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    });
    reload();
    setView({ kind: "list" });
  }

  function onView(input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) {
    const a = viewAction(input, key);
    if (!a) return;
    if (view.kind === "lines") {
      if (a.kind === "back" || a.kind === "quit") return setView({ kind: "list" });
      if (a.kind === "move") setView({ ...view, scroll: Math.min(Math.max(0, view.lines.length - height), Math.max(0, view.scroll + a.by)) });
      return;
    }
    if (view.kind !== "plan") return;
    const p = pending.current;
    if (view.phase === "choose" && view.choice) {
      const c = view.choice;
      if (a.kind === "move") return setPlan((v) => ({ ...v, choice: { ...c, cursor: Math.min(c.options.length - 1, Math.max(0, c.cursor + a.by)) } }));
      if (a.kind === "pick") {
        const o = c.options[c.cursor];
        return setPlan((v) => ({ ...v, choice: { ...c, picked: c.picked.includes(o) ? c.picked.filter((x) => x !== o) : [...c.picked, o] } }));
      }
      if (a.kind === "apply") {
        p.applied = true;
        if (c.source) setPicks((all) => ({ ...all, [c.source as string]: c.picked }));
        setPlan((v) => ({ ...v, phase: "running", choice: null }));
        return p.choose?.[0](c.picked);
      }
      if (a.kind === "back") return p.choose?.[1](new Cancelled());
      return;
    }
    if (view.phase === "confirm") {
      if (a.kind === "apply" || a.kind === "back") {
        setPlan((v) => ({ ...v, phase: "running" }));
        return p.confirm?.(a.kind === "apply");
      }
      return;
    }
    if (a.kind === "back" || a.kind === "quit") return setView({ kind: "list" });
    if (a.kind === "move") setPlan((v) => ({ ...v, scroll: Math.min(Math.max(0, v.lines.length - height), Math.max(0, v.scroll + a.by)) }));
  }

  return Screen({ data, rows, sel, pane, skills, skillSel, picks, view, message, columns, height });
}

export async function runTui(base: Paths): Promise<void> {
  const app = render(h(App, { base }), { alternateScreen: true });
  await app.waitUntilExit();
}
