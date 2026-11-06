import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const studioShellSources = [
  "src/projects/_components/project-ide-shell.tsx",
  "src/projects/studio/_hooks/studio-editor-actions.ts",
  "src/projects/studio/_components/studio-ide-styles.ts",
  "src/projects/studio/_components/studio-preview-session.tsx",
  "src/projects/studio/_components/studio-server-save.tsx",
  "src/projects/studio/_components/studio-shell-chrome.tsx",
  "src/projects/studio/_utils/studio-shell-labels.ts",
  "src/projects/studio/_utils/studio-shell-session.ts",
  "src/projects/studio/_components/studio-terminal-session.tsx",
  "src/projects/studio/_components/studio-workspace-session.tsx"
];

export function readStudioShellSources(): string {
  return studioShellSources.map((relative) => fs.readFileSync(path.join(webRoot, relative), "utf8")).join("\n");
}
