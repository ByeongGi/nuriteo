"use client";

import { addDays, differenceInCalendarDays, isValid, parseISO, startOfDay } from "date-fns";
import { useState } from "react";

import {
  accessTokenScopePresets,
  accessTokenScopes,
  type AccessTokenScopePreset
} from "@/app/(authenticated)/account/tokens/_schema/access-token.ts";

import type { AccessTokenScope } from "@nuriteo/api-client";

export function useTokenIssueForm() {
  const [expiryWindow] = useState(createExpiryWindow);
  const [expiresOn, setExpiresOn] = useState(expiryWindow.defaultValue);
  const [scopePreset, setScopePreset] = useState<AccessTokenScopePreset>("development");
  const [scopes, setScopes] = useState<readonly AccessTokenScope[]>(accessTokenScopePresets.development);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function selectScopePreset(nextPreset: string) {
    const preset = nextPreset as AccessTokenScopePreset;
    setScopePreset(preset);
    if (preset === "custom") {
      setAdvancedOpen(true);
      return;
    }
    setScopes(accessTokenScopePresets[preset]);
  }

  function toggleScope(scope: AccessTokenScope, checked: boolean) {
    setScopePreset("custom");
    setScopes((current) => checked
      ? accessTokenScopes.filter((candidate) => candidate === scope || current.includes(candidate))
      : current.filter((candidate) => candidate !== scope));
  }

  return {
    advancedOpen,
    expiresOn,
    expiryDescription: formatExpiryDescription(expiresOn),
    expiryWindow,
    scopePreset,
    scopes,
    selectScopePreset,
    setAdvancedOpen,
    setExpiresOn,
    toggleScope
  };
}

function createExpiryWindow() {
  const today = startOfDay(new Date());
  return {
    min: today,
    max: addDays(today, 365),
    defaultValue: addDays(today, 30)
  };
}

export function calculateExpiryDays(value: Date | string): number | undefined {
  const expiry = typeof value === "string" ? parseISO(value) : value;
  if (!isValid(expiry)) return undefined;
  return differenceInCalendarDays(expiry, startOfDay(new Date()));
}

function formatExpiryDescription(value: Date): string {
  const days = calculateExpiryDays(value);
  if (days === 0) return "오늘 발급 · 24시간 유효";
  return `${days ?? 0}일 후 만료`;
}
