import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { Lang } from "./content/types.ts";

export type ThemeMode = "system" | "light" | "dark";

const LANG_KEY = "nuriteo-docs-lang";
const THEME_KEY = "nuriteo-docs-theme";
const themeOrder: ThemeMode[] = ["system", "light", "dark"];

interface DocsPreferences {
  lang: Lang;
  theme: ThemeMode;
  toggleLang: () => void;
  cycleTheme: () => void;
}

const DocsPreferencesContext = createContext<DocsPreferences | null>(null);

export function DocsPreferencesProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(readLang);
  const [theme, setTheme] = useState<ThemeMode>(readTheme);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dataset.themeMode = theme;
    writePreference(LANG_KEY, lang);
    writePreference(THEME_KEY, theme);
  }, [lang, theme]);

  const value: DocsPreferences = {
    lang,
    theme,
    toggleLang: () => setLang((current) => current === "ko" ? "en" : "ko"),
    cycleTheme: () => setTheme((current) => themeOrder[(themeOrder.indexOf(current) + 1) % themeOrder.length] ?? "system")
  };

  return <DocsPreferencesContext.Provider value={value}>{children}</DocsPreferencesContext.Provider>;
}

export function useDocsPreferences(): DocsPreferences {
  const value = useContext(DocsPreferencesContext);
  if (!value) throw new Error("DocsPreferencesProvider is missing");
  return value;
}

export function themeLabel(lang: Lang, theme: ThemeMode): string {
  const labels: Record<Lang, Record<ThemeMode, string>> = {
    ko: { system: "시스템", light: "라이트", dark: "다크" },
    en: { system: "System", light: "Light", dark: "Dark" }
  };
  return labels[lang][theme];
}

function readLang(): Lang {
  return readPreference(LANG_KEY) === "en" ? "en" : "ko";
}

function readTheme(): ThemeMode {
  const value = readPreference(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing can reject storage. The in-memory choice still applies.
  }
}
