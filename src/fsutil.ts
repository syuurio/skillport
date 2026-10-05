import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run `fn` with a fresh private temp folder that is removed afterwards. */
export function withTempDir<T>(label: string, fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `skillport-${label}-`));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
