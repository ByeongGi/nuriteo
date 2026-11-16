export const EDITOR_FONT_SIZES = [12, 13, 14, 16, 18] as const;

export type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number];
export type EditorWordWrap = "off" | "on";

export interface EditorSettings {
  readonly fontSize: EditorFontSize;
  readonly minimap: boolean;
  readonly wordWrap: EditorWordWrap;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 13,
  minimap: true,
  wordWrap: "off"
};

const EDITOR_SETTINGS_STORAGE_KEY = "nuriteo:studio-editor-settings:v1";

interface JsonRecord {
  readonly [key: string]: unknown;
}

export function parseEditorFontSize(value: unknown): EditorFontSize {
  const fontSize = EDITOR_FONT_SIZES.find((size) => size === value || String(size) === value);
  return fontSize ?? DEFAULT_EDITOR_SETTINGS.fontSize;
}

export function parseEditorSettings(value: string | null | undefined): EditorSettings {
  if (value === null || value === undefined) return DEFAULT_EDITOR_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return DEFAULT_EDITOR_SETTINGS;
    return {
      fontSize: parseEditorFontSize(parsed.fontSize),
      minimap: typeof parsed.minimap === "boolean" ? parsed.minimap : DEFAULT_EDITOR_SETTINGS.minimap,
      wordWrap: parsed.wordWrap === "on" ? "on" : "off"
    };
  } catch {
    return DEFAULT_EDITOR_SETTINGS;
  }
}

export function readEditorSettings(): EditorSettings {
  if (typeof globalThis.localStorage === "undefined") return DEFAULT_EDITOR_SETTINGS;
  return parseEditorSettings(globalThis.localStorage.getItem(EDITOR_SETTINGS_STORAGE_KEY));
}

export function writeEditorSettings(settings: EditorSettings): void {
  if (typeof globalThis.localStorage === "undefined") return;
  globalThis.localStorage.setItem(EDITOR_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
