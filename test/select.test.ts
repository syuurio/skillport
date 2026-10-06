import assert from "node:assert/strict";
import { test } from "node:test";
import { settled } from "../src/select.ts";

const flags = { yes: false, interactive: false, dryRun: false };
const base = { setId: "s", available: ["a", "b", "c", "d"], exclude: ["d"], declined: [], flags, pick: false };

test("selection: installed skills stay; new ones wait to be asked, never installed on their own", () => {
  const s = settled({ ...base, installed: ["a"], declined: ["b"] });
  assert.deepEqual(s.want, ["a"]);
  assert.deepEqual(s.declined, ["b"]);
  assert.deepEqual(s.pending, ["c"]);
});

test("selection: -y installs everything only on a first install", () => {
  assert.deepEqual(settled({ ...base, installed: null, flags: { ...flags, yes: true } }).want, ["a", "b", "c"]);
  const later = settled({ ...base, installed: ["a"], flags: { ...flags, yes: true } });
  assert.deepEqual(later.want, ["a"]);
  assert.deepEqual(later.pending, ["b", "c"]);
});

test("selection: skills gone upstream drop out of want and declined", () => {
  const s = settled({ ...base, available: ["a"], installed: ["a", "x"], declined: ["y"] });
  assert.deepEqual(s.want, ["a"]);
  assert.deepEqual(s.declined, []);
});
