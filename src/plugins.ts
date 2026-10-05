import fs from "node:fs";
import path from "node:path";
import { readFrontmatterName } from "./transform.ts";

/**
 * Skill names shipped by installed Claude Code plugins, mapped to the plugin
 * name. Plugin skills are namespaced (`plugin:skill`), so a clash with one is
 * only a warning. Skills can sit at any depth under a plugin's `skills/`
 * (mattpocock-skills uses skills/engineering/<name>).
 */
export function pluginSkillNames(claudePluginsDir: string): Map<string, string> {
  const names = new Map<string, string>();
  const file = path.join(claudePluginsDir, "installed_plugins.json");
  if (!fs.existsSync(file)) return names;
  const installed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    plugins?: Record<string, { installPath: string }[]>;
  };
  for (const [key, installs] of Object.entries(installed.plugins ?? {})) {
    const plugin = key.split("@")[0];
    for (const { installPath } of installs) {
      const root = path.join(installPath, "skills");
      if (!fs.existsSync(root)) continue;
      for (const e of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
        if (!e.isFile() || e.name !== "SKILL.md") continue;
        const text = fs.readFileSync(path.join(e.parentPath, e.name), "utf8");
        names.set(readFrontmatterName(text).name ?? path.basename(e.parentPath), plugin);
      }
    }
  }
  return names;
}
