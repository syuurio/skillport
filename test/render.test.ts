import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SkillName, SourceId } from "../src/manifest.ts";
import { render } from "../src/render.ts";
import { setFrontmatterMetadata } from "../src/transform.ts";

const fixtures = path.join(import.meta.dirname, "fixtures", "v2", "local");

function renderFixture(original: string) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "skl-render-"));
  const to = path.join(out, `fx-${original}`);
  const r = render({
    from: path.join(fixtures, original),
    to,
    source: "fx" as SourceId,
    original: original as SkillName,
    name: `fx-${original}`,
    renames: new Map([
      ["alpha", "fx-alpha"],
      ["beta", "fx-beta"],
    ]),
  });
  return { to, ...r };
}

test("render names the folder and frontmatter and records provenance", () => {
  const { to } = renderFixture("alpha");
  assert.equal(path.basename(to), "fx-alpha");
  const md = fs.readFileSync(path.join(to, "SKILL.md"), "utf8");
  assert.match(md, /^---\nname: fx-alpha\n/);
  assert.match(md, /metadata:\n {2}author: fixture\n {2}skl-source: fx\n {2}skl-original: alpha\n---/);
});

test("render rewrites references between skills of the source, in every markdown file", () => {
  const { to, rewrites } = renderFixture("beta");
  assert.match(fs.readFileSync(path.join(to, "SKILL.md"), "utf8"), /The `fx-alpha` skill writes the plan/);
  assert.match(fs.readFileSync(path.join(to, "references", "steps.md"), "utf8"), /from the `fx-alpha` skill/);
  assert.deepEqual(
    rewrites.map((r) => `${r.file}:${r.change.line}`).sort(),
    ["fx-beta/SKILL.md:10", "fx-beta/references/steps.md:3"],
  );
});

test("render leaves the store copy untouched", () => {
  renderFixture("alpha");
  assert.match(fs.readFileSync(path.join(fixtures, "alpha", "SKILL.md"), "utf8"), /^---\nname: alpha\n/);
});

test("metadata keys are replaced, other keys kept, and a missing map added", () => {
  const set = (text: string) => setFrontmatterMetadata(text, { "skl-source": "fx" });
  assert.equal(set("---\nname: a\n---\nbody"), "---\nname: a\nmetadata:\n  skl-source: fx\n---\nbody");
  assert.equal(
    set("---\nmetadata:\n    skl-source: old\n    keep: yes\nname: a\n---\n"),
    "---\nmetadata:\n    keep: yes\n    skl-source: fx\nname: a\n---\n",
  );
  assert.equal(set("---\nmetadata: {}\n---\n"), "---\nmetadata:\n  skl-source: fx\n---\n");
  assert.throws(() => set("---\nmetadata: { a: b }\n---\n"), /not a block map/);
});
