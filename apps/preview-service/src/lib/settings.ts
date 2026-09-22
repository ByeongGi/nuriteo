export type SaveTrigger = "autosave" | "manual";
export type ColorTheme = "dark" | "light";

export interface IdeSettings {
  theme: ColorTheme;
  fontSize: number;
  saveTrigger: SaveTrigger;
  showPreview: boolean;
  showTerminal: boolean;
  showSidebar: boolean;
}

export const DEFAULT_SETTINGS: IdeSettings = {
  theme: "dark",
  fontSize: 13,
  saveTrigger: "autosave",
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
    return { ...DEFAULT_SETTINGS, ...parsed };
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
