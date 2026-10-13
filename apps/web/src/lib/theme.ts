export const THEME_COOKIE_NAME = "nuriteo-theme";

export const THEME_MODES = ["system", "light", "dark"] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

export function parseThemeMode(value: string | undefined): ThemeMode {
  return THEME_MODES.find((mode) => mode === value) ?? "system";
}
