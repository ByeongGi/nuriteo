export const EDITOR_THEME_PREFERENCES = ["system", "stackblitz-dark", "stackblitz-light"] as const;

export type EditorThemePreference = (typeof EDITOR_THEME_PREFERENCES)[number];

export const EDITOR_THEME_CHANGE_EVENT = "nuriteo:studio-editor-theme-change";

export const EDITOR_THEME_OPTIONS: readonly {
  readonly label: string;
  readonly value: EditorThemePreference;
}[] = [
  { label: "시스템 설정", value: "system" },
  { label: "StackBlitz Dark", value: "stackblitz-dark" },
  { label: "StackBlitz Light", value: "stackblitz-light" }
];

const EDITOR_THEME_STORAGE_KEY = "nuriteo:studio-editor-theme:v1";

export function parseEditorThemePreference(value: string | null | undefined): EditorThemePreference {
  return EDITOR_THEME_PREFERENCES.find((preference) => preference === value) ?? "system";
}

export function readEditorThemePreference(): EditorThemePreference {
  if (typeof globalThis.localStorage === "undefined") return "system";
  return parseEditorThemePreference(globalThis.localStorage.getItem(EDITOR_THEME_STORAGE_KEY));
}

export function writeEditorThemePreference(preference: EditorThemePreference): void {
  if (typeof globalThis.localStorage === "undefined") return;
  globalThis.localStorage.setItem(EDITOR_THEME_STORAGE_KEY, preference);
  globalThis.dispatchEvent(new CustomEvent<EditorThemePreference>(EDITOR_THEME_CHANGE_EVENT, { detail: preference }));
}
