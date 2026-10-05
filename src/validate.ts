import type { SkillSet } from "./registry.ts";
import { isValidSkillName } from "./transform.ts";

// Rules for registry entries, in one place. The registry is checked when it
// is read, so a hand-edited entry gets the same scrutiny as one the wizard
// wrote.

/**
 * A registry package spec pinned to an exact version: `name@1.2.3` or
 * `@scope/name@1.2.3`. Nothing else reaches `npm pack`: npm also accepts git
 * URLs, `owner/repo` shorthands, tarball URLs and local paths, and for git
 * sources it runs the repo's `prepare` script.
 */
const PINNED_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function isPinnedSpec(spec: string): boolean {
  return PINNED_SPEC.test(spec);
}

/** An npm package name, scoped or not. */
export function isPackageName(name: string): boolean {
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name);
}

// A flag carries a credential when one of its words (split on -, _ and camelCase) is
// one of these: --token, --api-key, --access-token, --license, --pat,
// --secret, --auth, --password. Whole words only, so --author or --keyboard
// do not match; --no-* switches never take a value.
const SECRET_WORDS = new Set([
  "token", "key", "apikey", "secret", "auth", "password", "passwd", "credential", "credentials", "license", "pat",
]);

function isSecretFlag(flag: string): boolean {
  if (!/^--?[A-Za-z]/.test(flag) || /^--no-/.test(flag)) return false;
  // Words split on -, _ and camelCase humps: --accessToken -> access, token.
  return flag
    .replace(/^-+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[-_]/)
    .some((w) => SECRET_WORDS.has(w));
}
// Values that are clearly not a credential: a path or a URL.
const NOT_A_SECRET = /^(\.{0,2}\/|~\/|https?:\/\/)/;

/**
 * Pull a pasted credential out of a command: `--token=abc` becomes
 * `--token={secret}` and `abc` is returned for Keychain. Handles the
 * `--token abc` form too.
 */
export function extractSecret(argv: string[]): { command: string[]; secret?: string } {
  const command = [...argv];
  for (let i = 0; i < command.length; i++) {
    const eq = command[i].indexOf("=");
    const flag = eq > 0 ? command[i].slice(0, eq) : command[i];
    if (!isSecretFlag(flag)) continue;
    const value = eq > 0 ? command[i].slice(eq + 1) : command[i + 1];
    if (!value || value === "{secret}" || value.startsWith("-") || NOT_A_SECRET.test(value)) continue;
    if (eq > 0) command[i] = `${flag}={secret}`;
    else command.splice(i, 2, `${flag}={secret}`);
    return { command, secret: value };
  }
  return { command };
}

/** `owner/repo` for GitHub sources in any spelling; other sources as given. */
export function normalizeSource(source: string): string {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(source.trim());
  return m ? m[1] : source.trim();
}

/** A path inside a folder: relative, no `..` segments. */
function isInside(p: unknown): boolean {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

const isWords = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Shapes of the per-set lists and rules; a wrong shape would silently change what installs. */
function validateCommon(set: SkillSet, problems: string[]): void {
  const raw = set as unknown as Record<string, unknown>;
  for (const key of ["skills", "exclude"] as const) {
    if (raw[key] !== undefined && !(isWords(raw[key]) && (raw[key] as string[]).every(isValidSkillName))) {
      problems.push(`${key} must be a list of skill names`);
    }
  }
  if (set.type === "skills-cli") return;
  if (raw.prefix !== undefined && !(typeof raw.prefix === "string" && isValidSkillName(raw.prefix))) {
    problems.push("prefix must be a-z, 0-9 and single hyphens");
  }
  if (raw.rename !== undefined) {
    const rules = raw.rename;
    const ok =
      typeof rules === "object" &&
      rules !== null &&
      !Array.isArray(rules) &&
      Object.entries(rules).every(
        ([from, r]) =>
          isValidSkillName(from) &&
          typeof r === "object" &&
          r !== null &&
          typeof (r as { to?: unknown }).to === "string" &&
          isValidSkillName((r as { to: string }).to) &&
          typeof (r as { reason?: unknown }).reason === "string",
      );
    if (!ok) problems.push('rename must map skill names to { "to": <skill name>, "reason": <text>, "at": <date> }');
  }
}

/** Problems with one entry; empty when it is usable. `linkIds` are the known link targets. */
export function validateEntry(id: string, set: SkillSet, linkIds: string[]): string[] {
  const problems: string[] = [];
  if (!isValidSkillName(id)) problems.push(`set id "${id}" must use a-z, 0-9 and single hyphens`);
  if (set.links !== undefined && !(isWords(set.links) && set.links.every((l) => linkIds.includes(l)))) {
    problems.push(`links must be a list of: ${linkIds.join(", ")}`);
  }
  validateCommon(set, problems);
  switch (set.type) {
    case "installer":
      if (!isWords(set.command) || set.command.length === 0) {
        problems.push("command must be a non-empty list of words");
        break;
      }
      if (set.unattended !== undefined && !isWords(set.unattended)) problems.push("unattended must be a list of words");
      if (set.secret !== undefined && set.secret !== "keychain") problems.push('secret must be "keychain"');
      if (set.secret === "keychain" && !set.command.some((a) => a.includes("{secret}"))) {
        problems.push("secret is set but no command word contains {secret}");
      }
      if (set.command.some((a) => a.includes("{secret}")) && set.secret !== "keychain") {
        problems.push('command uses {secret} but "secret" is not "keychain"');
      }
      if (extractSecret(set.command).secret !== undefined) {
        problems.push("command contains a literal token; use {secret} and store it with skl secret");
      }
      if (set.stage !== undefined && !(isWords(set.stage) && set.stage.every(isInside))) {
        problems.push("stage must be folders inside the sandbox HOME (relative, no ..)");
      }
      if (set.harvest !== undefined && !isInside(set.harvest)) {
        problems.push("harvest must be a folder inside the sandbox HOME (relative, no ..)");
      }
      break;
    case "npm":
      if (!isPinnedSpec(set.package ?? "")) problems.push("package must be a registry package pinned to a version, e.g. motion-ai@14.1.0");
      if (!isInside(set.path)) problems.push("path must be a folder inside the package (relative, no ..)");
      break;
    case "skills-cli":
      if (!set.source || /\s/.test(set.source) || set.source.startsWith("-")) {
        problems.push("source must be one word, as passed to npx skills add");
      }
      break;
    default:
      problems.push('type must be "installer", "npm" or "skills-cli"');
  }
  return problems;
}
