import { spawnSync } from "node:child_process";
import fs from "node:fs";

// macOS Keychain via the `security` CLI. One generic password per source:
// service "skillport", account = source id.
const SERVICE = "skillport";

export function readSecret(source: string): string {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", SERVICE, "-a", source, "-w"],
    { encoding: "utf8" },
  );
  const secret = r.status === 0 ? r.stdout.trim() : "";
  if (!secret) {
    throw new Error(
      `No Keychain secret for "${source}" (missing or empty). Run: skl secret ${source}`,
    );
  }
  return secret;
}

/**
 * Store a source's secret. On a terminal, `security` prompts for it (`-w` as
 * the last argument), so it never lands in shell history. Without a terminal
 * (pipes, `pbpaste |`, agent shells) the secret is read from stdin and
 * passed on through stdin as well.
 */
export function storeSecret(source: string): void {
  const base = ["add-generic-password", "-U", "-s", SERVICE, "-a", source];
  if (process.stdin.isTTY) {
    const r = spawnSync("security", [...base, "-w"], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("Keychain write failed.");
  } else {
    storeSecretValue(source, fs.readFileSync(0, "utf8"));
  }
  // Fails loudly if the prompt received nothing.
  readSecret(source);
}

// Token-like characters only: the value is written inside double quotes to
// `security -i`, so quotes, backslashes and whitespace are refused rather
// than escaped by guesswork.
const SAFE_SECRET = /^[A-Za-z0-9._~+/=:-]+$/;

/**
 * Store a secret you already have (pasted into the register wizard, or piped
 * in). It goes to `security -i` on stdin, never on a command line, so other
 * processes cannot read it from `ps`.
 */
export function storeSecretValue(source: string, raw: string): void {
  const value = raw.trim();
  if (!value) throw new Error("Empty secret; nothing stored.");
  if (!SAFE_SECRET.test(value)) {
    throw new Error(`The token has characters skillport will not pass along; store it with: skl secret ${source}`);
  }
  if (!/^[a-z0-9-]+$/.test(source)) throw new Error(`Invalid set id "${source}".`);
  const r = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -s ${SERVICE} -a ${source} -w "${value}"\n`,
    stdio: ["pipe", "ignore", "ignore"],
  });
  if (r.status !== 0) throw new Error("Keychain write failed.");
  readSecret(source);
}
