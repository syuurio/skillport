import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "ink";
import type { Lock } from "../src/lock.ts";
import { type SkillId, type SourceId, parseManifest } from "../src/manifest.ts";
import { defaultPaths } from "../src/paths.ts";
import type { Status } from "../src/status.ts";
import { type Frame, Screen } from "../src/tui/app.ts";
import { headerRight, listAction, skillRows, sourceRows, viewAction } from "../src/tui/model.ts";

const NOW = "2026-10-29T10:00:00.000Z";
const manifest = parseManifest(
  {
    version: 2,
    sources: {
      matt: { type: "github", repo: "mattpocock/skills" },
      motion: { type: "npm", package: "motion-ai@14.1.0", path: "content/skills" },
      legacy: { type: "local", path: "~/skills" },
      emil: { type: "installer", command: ["npx", "-y", "@emil/install@1.0.0", "--key", "{secret}"], secret: "keychain", unattended: [] },
      ask: { type: "installer", command: ["sh", "install.sh"] },
    },
  },
  "manifest.json",
);
const lock: Lock = {
  version: 2,
  sources: {},
  skills: {
    ["matt/tdd" as SkillId]: { name: "matt-tdd", base: "a", output: "b", updatedAt: NOW },
    ["matt/grilling" as SkillId]: { name: "matt-grilling", base: "a", output: "b", updatedAt: NOW },
    ["matt/review" as SkillId]: { name: "matt-review", base: "a", output: "b", patch: "p", updatedAt: NOW },
  },
};
const status: Status = {
  checkedAt: "2026-10-29T08:00:00.000Z",
  sources: {
    ["matt" as SourceId]: { checkedAt: NOW, state: "updates", from: "4f2a91c", to: "b81e0d3", changed: ["tdd"], added: ["deploy"], removed: [], link: "https://github.com/x" },
    ["motion" as SourceId]: { checkedAt: NOW, state: "up-to-date", pinned: "14.1.0" },
    ["legacy" as SourceId]: { checkedAt: NOW, state: "blocked", collisions: [{ name: "legacy-a", with: "npx skills" }] },
    ["emil" as SourceId]: { checkedAt: NOW, state: "needs-token" },
    ["ask" as SourceId]: { checkedAt: NOW, state: "unpinned" },
  },
  skills: { ["matt/review" as SkillId]: { customized: true }, ["matt/grilling" as SkillId]: { edited: true } },
};

test("rows: one per source, marked by state", () => {
  assert.deepEqual(
    sourceRows(manifest, status).map((r) => `${r.mark} ${r.id} ${r.state}`),
    ["● matt 1 update · 1 new", "✓ motion up to date (pinned 14.1.0)", "✗ legacy blocked: name collision", "✗ emil token missing: skl secret", "? ask not pinned: update to compare"],
  );
  assert.deepEqual(sourceRows(manifest, null)[0].state, "not checked yet");
  assert.equal(headerRight(status, Date.parse(NOW)), "checked 2h ago · r to re-check");
});

test("skill rows: installed skills with what check found, then new upstream ones", () => {
  assert.deepEqual(
    skillRows(lock, status, "matt" as SourceId).map((s) => [s.name, s.note, s.isNew]),
    [
      ["matt-grilling", "edited in place", false],
      ["matt-review", "customized", false],
      ["matt-tdd", "update   4f2a91c→b81e0d3", false],
      ["deploy", "new upstream (not picked)", true],
    ],
  );
});

test("keys map to the actions SPEC §12 names", () => {
  assert.deepEqual(listAction("u", {}), { kind: "update", all: false });
  assert.deepEqual(listAction("U", {}), { kind: "update", all: true });
  assert.deepEqual(listAction("", { downArrow: true }), { kind: "move", by: 1 });
  assert.deepEqual(listAction("", { rightArrow: true }), { kind: "pane", to: "skills" });
  assert.deepEqual(
    ["d", "o", " ", "r", "q", "x"].map((k) => listAction(k, {})?.kind ?? null),
    ["diff", "open", "pick", "recheck", "quit", null],
  );
  assert.deepEqual(viewAction("y", {}), { kind: "apply" });
  assert.deepEqual(viewAction("", { escape: true }), { kind: "back" });
  assert.equal(viewAction("u", {}), null);
});

const frame = (f: Partial<Frame>): Frame => ({
  data: { paths: defaultPaths("/h"), manifest, lock, status },
  rows: sourceRows(manifest, status),
  sel: 0,
  pane: "sources",
  skills: skillRows(lock, status, "matt" as SourceId),
  skillSel: 0,
  picks: {},
  view: { kind: "list" },
  message: "",
  columns: 110,
  height: 10,
  ...f,
});

test("the list frame shows sources, the selected source's skills and the key hints", () => {
  const out = renderToString(Screen(frame({ picks: { matt: ["deploy"] } })), { columns: 110 });
  assert.match(out, /skillport\s+checked .* · r to re-check/);
  assert.match(out, /● matt\s+1 update · 1 new/);
  assert.match(out, /matt · mattpocock\/skills/);
  assert.match(out, /matt-tdd\s+update {3}4f2a91c→b81e0d3/);
  assert.match(out, /◼ deploy\s+new upstream \(not picked\)/);
  assert.match(out, /u update {2}U update all {2}d diff {2}o open link {2}space pick new {2}r re-check {2}q quit/);
});

test("the plan frame shows update's lines, then the new-skill checklist or the Apply prompt", () => {
  const lines = ["matt  4f2a91c → b81e0d3", "  replace   matt-tdd", "  new       deploy"];
  const choose = renderToString(
    Screen(frame({ view: { kind: "plan", title: "Update matt", lines, scroll: 0, phase: "choose", choice: { source: "matt" as SourceId, question: "New skills in matt. Install any?", options: ["deploy", "ship"], picked: ["ship"], cursor: 0 } } })),
    { columns: 110 },
  );
  assert.match(choose, /Update matt[\s\S]*replace {3}matt-tdd[\s\S]*New skills in matt\. Install any\?[\s\S]*◻ deploy[\s\S]*◼ ship/);
  assert.match(choose, /space toggle {2}y apply {2}Esc cancel/);
  const confirm = renderToString(Screen(frame({ view: { kind: "plan", title: "Update matt", lines, scroll: 0, phase: "confirm", choice: null } })), { columns: 110 });
  assert.match(confirm, /Apply\? \(y \/ Esc\)/);
});

test("the token frame never shows the token", () => {
  const out = renderToString(Screen(frame({ sel: 3, view: { kind: "token", id: "emil" as SourceId, value: "s3cret" } })), { columns: 110 });
  assert.match(out, /Token for emil\s*│[\s\S]*••••••/);
  assert.doesNotMatch(out, /s3cret/);
});
