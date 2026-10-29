import fs from "node:fs";
import path from "node:path";
import { LINK_TARGETS } from "./paths.ts";
import { isValidSkillName, withPrefix } from "./transform.ts";
import { githubRepo, installerProblems, isWords, npmProblems, sourceProblem, validateLinkTargets } from "./validate.ts";

// The manifest is what you want; skl derives everything else from it.
// See docs/SPEC.md §5.1 and §6.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A key of `sources`; also the default prefix. */
export type SourceId = Brand<string, "SourceId">;
/** A skill's name as its vendor ships it. */
export type SkillName = Brand<string, "SkillName">;
/** `<source>/<original>`: a skill's identity, whatever it is installed as. */
export type SkillId = Brand<string, "SkillId">;

export const skillId = (source: SourceId, original: SkillName): SkillId => `${source}/${original}` as SkillId;

export function splitSkillId(id: SkillId): { source: SourceId; original: SkillName } {
  const at = id.indexOf("/");
  return { source: id.slice(0, at) as SourceId, original: id.slice(at + 1) as SkillName };
}

interface SourceCommon {
  /** Omitted: the source id. `false`: install under the vendor's names. */
  prefix?: string | false;
  /** Original name to installed name; wins over the prefix. */
  rename?: Record<string, string>;
  /** Originals to install. Omitted: all of them. */
  pick?: string[];
  exclude?: string[];
  /** Link targets for this source's skills. Omitted: the manifest's `targets`. */
  links?: string[];
}

export interface GithubSource extends SourceCommon {
  type: "github";
  repo: string;
}

export interface InstallerSource extends SourceCommon {
  type: "installer";
  /** argv as you would type it; `{secret}` is replaced at run time. */
  command: string[];
  /** Extra args for an unattended run. Omitted: it only runs interactively. */
  unattended?: string[];
  secret?: "keychain";
  stage?: string[];
  harvest?: string;
}

export interface NpmSource extends SourceCommon {
  type: "npm";
  package: string;
  path: string;
}

export interface LocalSource extends SourceCommon {
  type: "local";
  path: string;
}

export type Source = GithubSource | InstallerSource | NpmSource | LocalSource;

export interface Manifest {
  version: 2;
  /** Default link targets. Omitted: ["claude-code"]. */
  targets?: string[];
  linkTargets?: Record<string, { label?: string; dir: string }>;
  sources: Record<SourceId, Source>;
}

/** The name `original` from `source` is installed under (§6.1). */
export function installedName(sourceId: SourceId, original: SkillName, source: Source): string {
  const renamed = source.rename?.[original];
  if (renamed) return renamed;
  if (source.prefix === false) return original;
  return withPrefix(original, source.prefix ?? sourceId);
}

const isFolder = (p: unknown) => typeof p === "string" && (p.startsWith("/") || p.startsWith("~/")) && !p.split("/").includes("..");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function typeProblems(s: Record<string, unknown>): string[] {
  switch (s.type) {
    case "github": {
      const problem = sourceProblem(s.repo);
      if (problem) return [problem.replace("source", "repo")];
      return githubRepo(s.repo as string) ? [] : ["repo must be owner/repo or a GitHub URL"];
    }
    case "installer":
      return installerProblems(s);
    case "npm":
      return npmProblems(s);
    case "local":
      return isFolder(s.path) ? [] : ["path must be an absolute folder or start with ~/ (no ..)"];
    default:
      return ['type must be "github", "installer", "npm" or "local"'];
  }
}

function commonProblems(s: Record<string, unknown>, linkIds: string[]): string[] {
  const problems: string[] = [];
  if (s.prefix !== undefined && s.prefix !== false && !(typeof s.prefix === "string" && isValidSkillName(s.prefix))) {
    problems.push("prefix must be false or lowercase letters, digits and single hyphens");
  }
  if (s.rename !== undefined) {
    if (!isRecord(s.rename)) problems.push("rename must map original names to installed names");
    else {
      for (const [from, to] of Object.entries(s.rename)) {
        if (typeof to !== "string" || !isValidSkillName(to)) problems.push(`rename.${from} ${JSON.stringify(to)} is not a valid skill name`);
      }
    }
  }
  for (const key of ["pick", "exclude"] as const) {
    if (s[key] !== undefined && !isWords(s[key])) problems.push(`${key} must be a list of skill names`);
  }
  problems.push(...linksProblems("links", s.links, linkIds));
  return problems;
}

function linksProblems(at: string, links: unknown, linkIds: string[]): string[] {
  if (links === undefined) return [];
  if (!isWords(links)) return [`${at} must be a list of link target ids`];
  return links.filter((id) => !linkIds.includes(id)).map((id) => `${at}: unknown link target "${id}". Known: ${linkIds.join(", ")}`);
}

/** Validates a parsed manifest completely; throws listing every problem (§6.2). */
export function parseManifest(raw: unknown, file: string): Manifest {
  const fail = (problems: string[]) => new Error(`${file} has problems:\n  ${problems.join("\n  ")}`);
  if (!isRecord(raw) || raw.version !== 2) throw fail([`unsupported manifest version ${isRecord(raw) ? raw.version : raw}`]);
  if (!isRecord(raw.sources)) throw fail(["sources must map source ids to sources"]);

  const builtIn = Object.keys(LINK_TARGETS);
  const problems = validateLinkTargets(raw.linkTargets, builtIn);
  const linkIds = [...builtIn, ...(isRecord(raw.linkTargets) ? Object.keys(raw.linkTargets) : [])];
  problems.push(...linksProblems("targets", raw.targets, linkIds));

  const prefixOwner = new Map<string, string>();
  const renameOwner = new Map<string, string>();
  for (const [id, s] of Object.entries(raw.sources)) {
    const at = `sources.${id}`;
    if (!isValidSkillName(id)) problems.push(`${at}: id must be lowercase letters, digits and single hyphens`);
    if (!isRecord(s)) {
      problems.push(`${at}: must be an object with a type`);
      continue;
    }
    problems.push(...[...typeProblems(s), ...commonProblems(s, linkIds)].map((p) => `${at}: ${p}`));

    if (s.prefix !== false) {
      const prefix = typeof s.prefix === "string" ? s.prefix : id;
      const owner = prefixOwner.get(prefix);
      if (owner) problems.push(`${at}.prefix "${prefix}" is already used by ${owner}`);
      else prefixOwner.set(prefix, at);
    }
    if (isRecord(s.rename)) {
      for (const to of Object.values(s.rename)) {
        if (typeof to !== "string") continue;
        const owner = renameOwner.get(to);
        if (owner) problems.push(`"${to}" is the rename target of both ${owner} and ${at}`);
        else renameOwner.set(to, at);
      }
    }
  }
  if (problems.length) throw fail(problems);
  return raw as unknown as Manifest;
}

export function readManifest(file: string): Manifest {
  if (!fs.existsSync(file)) return { version: 2, sources: {} };
  return parseManifest(JSON.parse(fs.readFileSync(file, "utf8")), file);
}

export function writeManifest(file: string, manifest: Manifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
