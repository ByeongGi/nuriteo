import type { TemplateId } from "@nuriteo/browser-host";

export interface DeepLinkIntent {
  template?: TemplateId;
  github?: string;
  startScript?: string;
  file?: string;
  openPalette?: boolean;
}

const TEMPLATES = new Set<TemplateId>(["vite-react", "vite-ts", "minimal-npm", "minimal-pnpm", "next-app"]);

export function parseDeepLink(search = window.location.search): DeepLinkIntent {
  const params = new URLSearchParams(search);
  const intent: DeepLinkIntent = {};
  const template = params.get("template");
  if (template && TEMPLATES.has(template as TemplateId)) {
    intent.template = template as TemplateId;
  }
  const github = params.get("github") || params.get("repo");
  if (github) intent.github = github;
  // StackBlitz uses `terminal=dev`; keep startScript/start as aliases.
  const startScript = params.get("terminal") || params.get("startScript") || params.get("start");
  if (startScript) intent.startScript = startScript;
  const file = params.get("file");
  if (file) intent.file = normalizeFileParam(file);
  if (params.get("palette") === "1") intent.openPalette = true;
  return intent;
}

export function hasDeepLinkIntent(intent: DeepLinkIntent): boolean {
  return Boolean(intent.template || intent.github || intent.file || intent.startScript || intent.openPalette);
}

export function clearDeepLinkParams(): void {
  const url = new URL(window.location.href);
  ["template", "github", "repo", "startScript", "start", "terminal", "file", "palette"].forEach((key) => {
    url.searchParams.delete(key);
  });
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function normalizeFileParam(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}
