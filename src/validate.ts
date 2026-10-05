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

// A last word that makes a flag about a credential rather than the credential
// itself: --key-file, --auth-method, --token-url. Only the last word counts:
// --host-token and --file-token still carry a token.
const NOT_THE_SECRET = new Set(["file", "path", "dir", "method", "type", "mode", "url", "host", "server", "endpoint", "name"]);
// Exact license identifiers, for a flag named exactly --license: --license MIT.
const SPDX_IDS = new Set([
  "mit", "isc", "unlicense", "0bsd", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "mpl-2.0", "epl-2.0", "bsl-1.0", "cc0-1.0",
  "gpl-2.0", "gpl-3.0", "lgpl-2.1", "lgpl-3.0", "agpl-3.0", "mit-0", "bsd-1-clause", "cc-by-4.0", "cc-by-sa-4.0",
  "zlib", "artistic-2.0", "upl-1.0", "wtfpl", "unlicensed",
]);
const isSpdx = (v: string) => SPDX_IDS.has(v.toLowerCase().replace(/-(only|or-later)$/, ""));

function isSecretFlag(flag: string): boolean {
  if (!/^--?[A-Za-z]/.test(flag) || /^--no-/.test(flag)) return false;
  // Words split on -, _ and camelCase humps: --accessToken -> access, token.
  const words = flag
    .replace(/^-+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[-_]/);
  if (NOT_THE_SECRET.has(words[words.length - 1])) return false;
  return words.some((w) => SECRET_WORDS.has(w));
}
// Values that are clearly not a credential: a path or a URL.
// A path has at least one folder separator after its start (/etc/x, ./k.pem,
// ~/.ssh/id); a lone "/AbC+def==" is a base64 token. A URL is not a secret
// unless it carries user:password@.
const looksLikePath = (v: string) => /^(\.{1,2}\/|~\/|\/[^/\s]+\/)/.test(v);
const looksLikePlainUrl = (v: string) => /^https?:\/\//.test(v) && !/^https?:\/\/[^/@\s]+:[^/@\s]+@/.test(v);

/**
 * Pull a pasted credential out of a command: `--token=abc` becomes
 * `--token={secret}` and `abc` is returned for Keychain. Handles the
 * `--token abc` form too.
 */
// Values that are credentials wherever they appear: well-known token
// prefixes (GitHub, GitLab, npm, Slack, Stripe/OpenAI-style, AWS keys).
const TOKEN_SHAPE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk(?:_live|_test)?[-_][A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})/;
// user:password@ in a URL.
const URL_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^/:@\s]+:)([^/@\s]+)(@.*)$/i;
// An Authorization header value: "Authorization: Bearer <x>" or "Basic <x>".
const AUTH_HEADER = /^(authorization:\s*(?:bearer|basic|token)\s+)(\S+)$/i;

/**
 * A credential embedded in one word, wherever it sits: a URL password, an
 * Authorization header, or a token with a well-known prefix. Returns the
 * word with {secret} in its place.
 */
function embeddedSecret(word: string): { word: string; secret: string } | null {
  if (word.includes("{secret}")) return null;
  const url = URL_PASSWORD.exec(word);
  if (url) return { word: `${url[1]}{secret}${url[3]}`, secret: url[2] };
  const header = AUTH_HEADER.exec(word);
  if (header) return { word: `${header[1]}{secret}`, secret: header[2] };
  const token = TOKEN_SHAPE.exec(word);
  if (token) return { word: word.replace(token[1], "{secret}"), secret: token[1] };
  return null;
}

export function extractSecret(argv: string[]): { command: string[]; secret?: string } {
  const command = [...argv];
  for (let i = 0; i < command.length; i++) {
    const embedded = embeddedSecret(command[i]);
    if (embedded) {
      command[i] = embedded.word;
      return { command, secret: embedded.secret };
    }
    // An environment assignment in front of the command: GITHUB_TOKEN=ghp_… npx x
    const env = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(command[i]);
    if (env && isSecretFlag(`--${env[1]}`) && env[2] !== "{secret}") {
      command[i] = `${env[1]}={secret}`;
      return { command, secret: env[2] };
    }
    const eq = command[i].indexOf("=");
    const flag = eq > 0 ? command[i].slice(0, eq) : command[i];
    if (!isSecretFlag(flag)) continue;
    const value = eq > 0 ? command[i].slice(eq + 1) : command[i + 1];
    if (!value || value === "{secret}" || value.startsWith("-") || looksLikePath(value) || looksLikePlainUrl(value)) continue;
    if (/^--?license$/i.test(flag) && isSpdx(value)) continue;
    if (eq > 0) command[i] = `${flag}={secret}`;
    else command.splice(i, 2, `${flag}={secret}`);
    return { command, secret: value };
  }
  return { command };
}

/** `owner/repo` (lowercased: GitHub is case-insensitive) from a GitHub URL or shorthand; null otherwise. */
export function githubRepo(source: string): string | null {
  const m = /^(?:(?:git\+)?https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(source.trim());
  return m ? m[1].toLowerCase() : null;
}

/** `owner/repo` for GitHub sources in any spelling; other sources as given. */
export function normalizeSource(source: string): string {
  return githubRepo(source) ?? source.trim();
}

/**
 * The set that already uses `source` (compared as normalizeSource does), if
 * any. npx skills' lock cannot tell two sets on one source apart.
 */
export function setUsingSource(sets: Record<string, SkillSet>, source: string, exceptId?: string): string | undefined {
  const key = normalizeSource(source);
  return Object.entries(sets).find(
    ([id, s]) => id !== exceptId && s.type === "skills-cli" && typeof s.source === "string" && normalizeSource(s.source) === key,
  )?.[0];
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
      if (isWords(set.unattended) && extractSecret(set.unattended).secret !== undefined) {
        problems.push("unattended contains a literal token; use {secret} and store it with skl secret");
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
      } else if (embeddedSecret(set.source)) {
        problems.push("source contains a credential; it would be passed to npx skills and stored in its lock");
      }
      break;
    default:
      problems.push('type must be "installer", "npm" or "skills-cli"');
  }
  return problems;
}
