import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isValidSkillName,
  readFrontmatterName,
  rewriteReferences,
  setFrontmatterName,
  withPrefix,
} from "../src/transform.ts";

test("withPrefix adds the prefix once", () => {
  assert.equal(withPrefix("animate", "emil"), "emil-animate");
  assert.equal(withPrefix("emil-design-eng", "emil"), "emil-design-eng");
  assert.equal(withPrefix(withPrefix("animate", "emil"), "emil"), "emil-animate");
});

test("withPrefix keeps a name equal to the prefix", () => {
  assert.equal(withPrefix("motion", "motion"), "motion");
});

test("withPrefix matches the hyphen, not just the letters", () => {
  assert.equal(withPrefix("emily-foo", "emil"), "emil-emily-foo");
});

test("isValidSkillName follows the Agent Skills spec", () => {
  assert.ok(isValidSkillName("emil-animate"));
  assert.ok(!isValidSkillName("emil@animate"));
  assert.ok(!isValidSkillName("emil--animate"));
  assert.ok(!isValidSkillName("Emil-animate"));
  assert.ok(!isValidSkillName("-animate"));
  assert.ok(!isValidSkillName("a".repeat(65)));
});

test("frontmatter name is read, quoted or not, and rewritten in place", () => {
  const md = '---\nname: "gesture-ui"\ndescription: x\n---\nbody name: no';
  assert.equal(readFrontmatterName(md).name, "gesture-ui");
  const out = setFrontmatterName(md, "emil-gesture-ui");
  assert.equal(out, "---\nname: emil-gesture-ui\ndescription: x\n---\nbody name: no");
});

test("frontmatter name is added when missing", () => {
  assert.equal(
    setFrontmatterName("---\ndescription: x\n---\n", "a"),
    "---\nname: a\ndescription: x\n---\n",
  );
  assert.equal(setFrontmatterName("body", "a"), "---\nname: a\n---\nbody");
});

test("rewriteReferences only touches exact backticked names", () => {
  const renames = new Map([
    ["animate", "emil-animate"],
    ["emil-design-eng", "emil-design-eng"],
  ]);
  const src = [
    "Use `animate` for intros.",
    "Not `animate()` nor `animated` nor animate.",
    "See `emil-design-eng`.",
  ].join("\n");
  const r = rewriteReferences(src, renames);
  assert.equal(r.text.split("\n")[0], "Use `emil-animate` for intros.");
  assert.equal(r.text.split("\n")[1], "Not `animate()` nor `animated` nor animate.");
  assert.equal(r.text.split("\n")[2], "See `emil-design-eng`.");
  assert.deepEqual(r.changes, [{ line: 1, from: "animate", to: "emil-animate" }]);
});

test("one-word names need skill context; hyphenated names do not", () => {
  const renames = new Map([
    ["animate", "emil-animate"],
    ["animation-performance", "emil-animation-performance"],
  ]);
  const lines = [
    "`initial`/`animate`/`exit` props", // code: keep
    "not the `animate` prop", // code: keep
    "see the `animate` skill", // skill word
    "To implement one directly, use `animate`.", // verb
    "Hero intros → `animate`.", // arrow
    "for GPU concerns, `animation-performance`.", // hyphenated: always
  ];
  const r = rewriteReferences(lines.join("\n"), renames);
  assert.deepEqual(r.skipped.map((c) => c.line), [1, 2]);
  assert.deepEqual(r.changes.map((c) => c.line), [3, 4, 5, 6]);
});

test("a one-word name in a list of skills is a reference", () => {
  const renames = new Map([
    ["animate", "emil-animate"],
    ["review-animations", "emil-review-animations"],
  ]);
  const r = rewriteReferences(
    "If installed: `animate` implements it, `review-animations` audits it.",
    renames,
  );
  assert.equal(r.skipped.length, 0);
  assert.match(r.text, /`emil-animate` implements/);
});
