// Pure name and content transforms. No filesystem access here, so every rule
// is unit-testable.

// Agent Skills spec: https://agentskills.io/specification (OpenCode enforces
// the same regex). Max 64 chars, lowercase alnum, single hyphens.
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
  return name.length <= 64 && NAME_RE.test(name);
}

/**
 * Add `<prefix>-` unless the name already carries it or is the prefix itself
 * (so `motion` stays `motion`, not `motion-motion`). Idempotent.
 */
export function withPrefix(name: string, prefix: string): string {
  if (name === prefix || name.startsWith(`${prefix}-`)) return name;
  return `${prefix}-${name}`;
}

export interface Frontmatter {
  name: string | null;
  /** Zero-based line index of the `name:` field, for in-place rewrite. */
  nameLine: number | null;
}

/** Read `name` from the leading YAML frontmatter block of a SKILL.md. */
export function readFrontmatterName(text: string): Frontmatter {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { name: null, nameLine: null };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const m = /^name:\s*(.*?)\s*$/.exec(line);
    if (m) return { name: unquote(m[1]), nameLine: i };
  }
  return { name: null, nameLine: null };
}

function unquote(v: string): string {
  const m = /^(["'])(.*)\1$/.exec(v);
  return m ? m[2] : v;
}

/** Replace the frontmatter `name:` value. Adds the field if it is missing. */
export function setFrontmatterName(text: string, name: string): string {
  const lines = text.split("\n");
  const fm = readFrontmatterName(text);
  if (fm.nameLine !== null) {
    lines[fm.nameLine] = `name: ${name}`;
    return lines.join("\n");
  }
  if (lines[0]?.trim() === "---") {
    lines.splice(1, 0, `name: ${name}`);
    return lines.join("\n");
  }
  return `---\nname: ${name}\n---\n${text}`;
}

export interface Change {
  line: number;
  from: string;
  to: string;
}

/**
 * A one-word name like `animate` is also a code identifier (Motion's
 * `animate` prop), so it only counts as a skill reference when the line
 * says so: the word "skill", a verb such as "use `animate`", or another
 * hyphenated skill name on the same line (a list of skills).
 */
function readsAsSkillReference(
  line: string,
  offset: number,
  renames: ReadonlyMap<string, string>,
): boolean {
  if (/\bskills?\b/i.test(line)) return true;
  const before = line.slice(Math.max(0, offset - 16), offset);
  if (/(?:\b(?:use|see|load|invoke|run|try)(?:\s+the)?|→)\s*$/i.test(before)) {
    return true;
  }
  const known = new Set([...renames].flat().filter((n) => n.includes("-")));
  return [...line.matchAll(/`([a-z0-9-]+)`/g)].some((m) => known.has(m[1]));
}

/**
 * Rewrite cross-skill references written as `old-name` (inline code) to the
 * new name. Only exact backtick-wrapped names in `renames` are touched; this
 * is the only reference form the audited skills use. Hyphenated names are
 * unambiguous and always rewritten; one-word names need skill context and
 * are reported in `skipped` otherwise.
 */
export function rewriteReferences(
  text: string,
  renames: ReadonlyMap<string, string>,
): { text: string; changes: Change[]; skipped: Change[] } {
  const changes: Change[] = [];
  const skipped: Change[] = [];
  const lines = text.split("\n");
  const out = lines.map((line, i) =>
    line.replace(/`([a-z0-9-]+)`/g, (whole, name: string, offset: number) => {
      const to = renames.get(name);
      if (!to || to === name) return whole;
      const change = { line: i + 1, from: name, to };
      if (!name.includes("-") && !readsAsSkillReference(line, offset, renames)) {
        skipped.push(change);
        return whole;
      }
      changes.push(change);
      return `\`${to}\``;
    }),
  );
  return { text: out.join("\n"), changes, skipped };
}
