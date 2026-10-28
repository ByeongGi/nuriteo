import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const studioShellSources = [
  "src/projects/project-ide-shell.tsx",
  "src/projects/studio/studio-editor-actions.ts",
  "src/projects/studio/studio-ide-styles.ts",
  "src/projects/studio/studio-preview-session.tsx",
  "src/projects/studio/studio-server-save.tsx",
  "src/projects/studio/studio-shell-chrome.tsx",
  "src/projects/studio/studio-shell-labels.ts",
  "src/projects/studio/studio-shell-session.ts",
  "src/projects/studio/studio-terminal-session.tsx",
  "src/projects/studio/studio-workspace-session.tsx"
];

export function readStudioShellSources(): string {
  return studioShellSources.map((relative) => fs.readFileSync(path.join(webRoot, relative), "utf8")).join("\n");
}
