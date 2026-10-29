import { isValidSkillName } from "./transform.ts";

// Rules for manifest sources, in one place. The manifest is checked when it
// is read, so a hand-edited source gets the same scrutiny as one skl add
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

// Values that are credentials wherever they appear: well-known token
// prefixes (GitHub, GitLab, npm, Slack, Anthropic, OpenAI, Stripe, AWS), not
// preceded by a letter or digit so "risk-assess..." is not "sk-...".
const TOKEN_SHAPE =
  /(?<![A-Za-z0-9])(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})/;
// user:password@ in a URL, anywhere in the word (--registry=https://u:p@h/).
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^/:@\s]+:)([^/@\s]+)(@)/i;
// An Authorization header value, anywhere in the word (--header=Authorization: Bearer x).
const AUTH_HEADER = /(authorization:\s*(?:bearer|basic|token)\s+)(\S+)/i;

/**
 * A credential embedded in one word, wherever it sits: a URL password, an
 * Authorization header, or a token with a well-known prefix. Returns the
 * word with {secret} in its place.
 */
function embeddedSecret(word: string): { word: string; secret: string } | null {
  if (word.includes("{secret}")) return null;
  const url = URL_PASSWORD.exec(word);
  if (url) return { word: word.replace(url[0], `${url[1]}{secret}${url[3]}`), secret: url[2] };
  const header = AUTH_HEADER.exec(word);
  if (header) return { word: word.replace(header[0], `${header[1]}{secret}`), secret: header[2] };
  // Every match, not the first: a name such as sk-design-system earlier in
  // the word must not hide a key after it.
  const token = [...word.matchAll(new RegExp(TOKEN_SHAPE, "g"))].find((m) => !looksLikeName(m[1]));
  if (token) return { word: word.replace(token[1], "{secret}"), secret: token[1] };
  return null;
}

/**
 * sk- keys come in many hyphenated forms (sk-proj-, sk-ant-api03-,
 * sk-svcacct-, sk-None-, ...), so their shape alone cannot tell them from a
 * package or repo name such as sk-design-system-skills. Names are lower-case
 * words, with at most a short number such as a year. Keys are random: upper
 * case, or long runs mixing letters and digits (sk- plus 32 hex, say).
 */
function looksLikeName(match: string): boolean {
  if (!match.startsWith("sk-") || /[A-Z]/.test(match)) return false;
  return match.slice(3).split("-").every((seg) => /^[a-z]{1,15}$/.test(seg) || /^[0-9]{1,4}$/.test(seg));
}

/** Whether a set's words use {secret} (command and unattended). */
export function usesSecret(set: { command?: unknown; unattended?: unknown }): boolean {
  return [set.command, set.unattended].some((w) => isWords(w) && w.some((a) => a.includes("{secret}")));
}

// Leading NAME=value words are the installer's environment, as in a shell.
const ENV_WORD = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
// Names a prefix may not set: they are skillport's sandbox (HOME, PATH,
// TMPDIR) or change what code runs (NODE_OPTIONS, NODE_PATH, DYLD_*). npm
// settings are matched in isReservedEnv.
const RESERVED_ENV = /^(HOME|PATH|TMPDIR|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*)$/;

/**
 * Whether an environment prefix may not set `name`. The one list, for both
 * validation and running. npm reads its settings case-insensitively, so
 * npm_config_* is matched in any case. Pass-through settings such as
 * HTTPS_PROXY or LANG are allowed: a prefix overriding them is legitimate.
 */
export function isReservedEnv(name: string): boolean {
  return RESERVED_ENV.test(name) || /^npm_config_/i.test(name);
}

/** The environment prefix of a set's run: leading NAME=value words of command + unattended, as acquire runs them. */
export function runEnvNames(set: { command?: unknown; unattended?: unknown }): string[] {
  const words = [...(isWords(set.command) ? set.command : []), ...(isWords(set.unattended) ? set.unattended : [])];
  return leadingEnv(words).env.map(([n]) => n);
}

/** Split leading NAME=value words off a command. The one rule for both validation and running. */
export function leadingEnv(words: string[]): { env: [string, string][]; rest: string[] } {
  const env: [string, string][] = [];
  let i = 0;
  for (; i < words.length; i++) {
    const m = ENV_WORD.exec(words[i]);
    if (!m) break;
    env.push([m[1], m[2]]);
  }
  return { env, rest: words.slice(i) };
}

/**
 * Pull a pasted credential out of a command: `--token=abc` becomes
 * `--token={secret}` and `abc` is returned for Keychain. Also handles
 * `--token abc`, a leading GITHUB_TOKEN=abc, and credentials embedded in a
 * word (URL passwords, Authorization headers, well-known token prefixes).
 */
export function extractSecret(argv: string[]): { command: string[]; secret?: string } {
  const command = [...argv];
  for (let i = 0; i < command.length; i++) {
    const embedded = embeddedSecret(command[i]);
    if (embedded) {
      command[i] = embedded.word;
      return { command, secret: embedded.secret };
    }
    // An environment assignment in front of the command: GITHUB_TOKEN=ghp_… npx x
    const env = i < leadingEnv(command).env.length ? ENV_WORD.exec(command[i]) : null;
    if (env && env[2] && isSecretFlag(`--${env[1]}`) && env[2] !== "{secret}") {
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

/** A path inside a folder: relative, no `..` segments. */
export function isInside(p: unknown): boolean {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

export const isWords = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** What is wrong with a source passed to npx skills, if anything. */
export function sourceProblem(source: unknown): string | undefined {
  if (typeof source !== "string" || !source || /\s/.test(source) || source.startsWith("-")) {
    return "source must be one word, as passed to npx skills add";
  }
  if (embeddedSecret(source)) return "source contains a credential; it would be passed to npx skills and stored in its lock";
  return undefined;
}

/** Problems with the manifest's own link targets; `builtIn` ids may not be redefined. */
export function validateLinkTargets(targets: unknown, builtIn: string[]): string[] {
  if (targets === undefined) return [];
  if (typeof targets !== "object" || targets === null || Array.isArray(targets)) {
    return ['linkTargets must map ids to { "dir": <folder>, "label": <text> }'];
  }
  const problems: string[] = [];
  for (const [id, t] of Object.entries(targets)) {
    const at = `linkTargets.${id}`;
    if (!isValidSkillName(id)) problems.push(`${at}: id must use a-z, 0-9 and single hyphens`);
    if (builtIn.includes(id)) problems.push(`${at}: "${id}" is built in; pick another id`);
    const { dir, label } = (typeof t === "object" && t !== null ? t : {}) as { dir?: unknown; label?: unknown };
    if (typeof dir !== "string" || !(dir.startsWith("/") || dir.startsWith("~/")) || dir.split("/").includes("..")) {
      problems.push(`${at}: dir must be an absolute folder or start with ~/ (no ..)`);
    }
    if (label !== undefined && typeof label !== "string") problems.push(`${at}: label must be text`);
  }
  return problems;
}

interface InstallerFields {
  command?: unknown;
  unattended?: unknown;
  secret?: unknown;
  stage?: unknown;
  harvest?: unknown;
}

/** Problems with an installer's run: its words, secret handling, environment and sandbox paths. */
export function installerProblems(set: InstallerFields): string[] {
  if (!isWords(set.command) || set.command.length === 0) return ["command must be a non-empty list of words"];
  const problems: string[] = [];
  if (set.unattended !== undefined && !isWords(set.unattended)) problems.push("unattended must be a list of words");
  if (set.secret !== undefined && set.secret !== "keychain") problems.push('secret must be "keychain"');
  if (set.secret === "keychain" && !usesSecret(set)) {
    problems.push("secret is set but no command or unattended word contains {secret}");
  }
  if (usesSecret(set) && set.secret !== "keychain") {
    problems.push('{secret} is used but "secret" is not "keychain"');
  }
  for (const name of runEnvNames(set)) {
    if (isReservedEnv(name)) problems.push(`command may not set ${name}: skillport controls it for the sandbox`);
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
  return problems;
}

/** Problems with an npm package source: pinned to a version, and a folder inside the package. */
export function npmProblems(set: { package?: unknown; path?: unknown }): string[] {
  const problems: string[] = [];
  if (!isPinnedSpec(typeof set.package === "string" ? set.package : "")) {
    problems.push("package must be a registry package pinned to a version, e.g. motion-ai@14.1.0");
  }
  if (!isInside(set.path)) problems.push("path must be a folder inside the package (relative, no ..)");
  return problems;
}
