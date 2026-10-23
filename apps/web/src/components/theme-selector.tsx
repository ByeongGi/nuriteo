"use client";

import { useState } from "react";

import { SelectField } from "#src/components/ui/field.tsx";
import { parseThemeMode, THEME_COOKIE_NAME, THEME_MODES } from "#src/lib/theme.ts";
import type { ThemeMode } from "#src/lib/theme.ts";

const THEME_COOKIE_MAX_AGE_SECONDS = 31_536_000;

interface ThemeSelectorProps {
  className?: string;
  initialMode: ThemeMode;
  triggerClassName?: string;
}

export function ThemeSelector({ className, initialMode, triggerClassName }: ThemeSelectorProps) {
  const [mode, setMode] = useState(initialMode);

  function updateTheme(value: string) {
    const nextMode = parseThemeMode(value);
    document.documentElement.dataset.themeMode = nextMode;
    document.cookie = `${THEME_COOKIE_NAME}=${nextMode}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
    setMode(nextMode);
  }

  return (
    <SelectField
      {...(className === undefined ? {} : { className })}
      density="compact"
      label="화면 테마"
      labelHidden
      options={THEME_MODES.map((themeMode) => ({ value: themeMode, label: themeLabel(themeMode) }))}
      {...(triggerClassName === undefined ? {} : { triggerClassName })}
      value={mode}
      onValueChange={updateTheme}
    />
  );
}

function themeLabel(mode: ThemeMode): string {
  if (mode === "light") return "밝은 테마";
  if (mode === "dark") return "어두운 테마";
  return "시스템 테마";
}
