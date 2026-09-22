export type SaveTrigger = "autosave" | "manual";
export type ColorTheme = "dark" | "light" | "high-contrast";
export type IconTheme = "color" | "monochrome";

export interface IdeSettings {
  theme: ColorTheme;
  fontSize: number;
  saveTrigger: SaveTrigger;
  iconTheme: IconTheme;
  editorMinimap: boolean;
  wordWrap: boolean;
  showPreview: boolean;
  showTerminal: boolean;
  showSidebar: boolean;
}

export const DEFAULT_SETTINGS: IdeSettings = {
  theme: "dark",
  fontSize: 13,
  saveTrigger: "autosave",
  iconTheme: "color",
  editorMinimap: false,
  wordWrap: false,
  showPreview: true,
  showTerminal: true,
  showSidebar: true
};

const STORAGE_KEY = "cargo.preview-service.settings";

export function loadSettings(): IdeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<IdeSettings>;
    return normalizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: IdeSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  applySettingsToDocument(settings);
}

export function applySettingsToDocument(settings: IdeSettings): void {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.iconTheme = settings.iconTheme;
  document.documentElement.style.setProperty("--editor-font-size", `${settings.fontSize}px`);
  if (settings.theme === "light") {
    document.documentElement.style.setProperty("--bg", "#f4f6fa");
    document.documentElement.style.setProperty("--bg-elevated", "#ffffff");
    document.documentElement.style.setProperty("--panel", "#ffffff");
    document.documentElement.style.setProperty("--panel-2", "#eef2f7");
    document.documentElement.style.setProperty("--line", "#d5dbe6");
    document.documentElement.style.setProperty("--line-strong", "#b7c0cf");
    document.documentElement.style.setProperty("--ink", "#1a2230");
    document.documentElement.style.setProperty("--muted", "#5b677a");
  } else if (settings.theme === "high-contrast") {
    document.documentElement.style.setProperty("--bg", "#000000");
    document.documentElement.style.setProperty("--bg-elevated", "#050505");
    document.documentElement.style.setProperty("--panel", "#090909");
    document.documentElement.style.setProperty("--panel-2", "#111111");
    document.documentElement.style.setProperty("--line", "#ffffff");
    document.documentElement.style.setProperty("--line-strong", "#ffd75f");
    document.documentElement.style.setProperty("--ink", "#ffffff");
    document.documentElement.style.setProperty("--muted", "#d7d7d7");
  } else {
    document.documentElement.style.removeProperty("--bg");
    document.documentElement.style.removeProperty("--bg-elevated");
    document.documentElement.style.removeProperty("--panel");
    document.documentElement.style.removeProperty("--panel-2");
    document.documentElement.style.removeProperty("--line");
    document.documentElement.style.removeProperty("--line-strong");
    document.documentElement.style.removeProperty("--ink");
    document.documentElement.style.removeProperty("--muted");
  }
}

export function monacoTheme(theme: ColorTheme): "vs" | "vs-dark" | "hc-black" {
  if (theme === "light") return "vs";
  if (theme === "high-contrast") return "hc-black";
  return "vs-dark";
}

function normalizeSettings(parsed: Partial<IdeSettings>): IdeSettings {
  return {
    theme: parsed.theme === "light" || parsed.theme === "high-contrast" ? parsed.theme : "dark",
    iconTheme: parsed.iconTheme === "monochrome" ? "monochrome" : "color",
    fontSize: typeof parsed.fontSize === "number" && parsed.fontSize >= 11 && parsed.fontSize <= 20
      ? parsed.fontSize
      : DEFAULT_SETTINGS.fontSize,
    saveTrigger: parsed.saveTrigger === "manual" ? "manual" : "autosave",
    editorMinimap: parsed.editorMinimap === true,
    wordWrap: parsed.wordWrap === true,
    showPreview: parsed.showPreview !== false,
    showTerminal: parsed.showTerminal !== false,
    showSidebar: parsed.showSidebar !== false
  };
}
