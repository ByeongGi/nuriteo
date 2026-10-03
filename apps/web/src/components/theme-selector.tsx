"use client";

import { useState } from "react";
import type { ChangeEvent } from "react";

import { parseThemeMode, THEME_COOKIE_NAME, THEME_MODES } from "../lib/theme.ts";
import type { ThemeMode } from "../lib/theme.ts";

const THEME_COOKIE_MAX_AGE_SECONDS = 31_536_000;

interface ThemeSelectorProps {
  initialMode: ThemeMode;
}

export function ThemeSelector({ initialMode }: ThemeSelectorProps) {
  const [mode, setMode] = useState(initialMode);

  function updateTheme(event: ChangeEvent<HTMLSelectElement>) {
    const nextMode = parseThemeMode(event.target.value);
    document.documentElement.dataset.themeMode = nextMode;
    document.cookie = `${THEME_COOKIE_NAME}=${nextMode}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
    setMode(nextMode);
  }

  return (
    <label className="theme-selector">
      <span className="sr-only">Appearance</span>
      <select
        aria-label="Appearance"
        className="theme-selector__control"
        value={mode}
        onChange={updateTheme}
      >
        {THEME_MODES.map((themeMode) => (
          <option key={themeMode} value={themeMode}>
            {themeMode === "system" ? "System theme" : `${capitalize(themeMode)} theme`}
          </option>
        ))}
      </select>
    </label>
  );
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
