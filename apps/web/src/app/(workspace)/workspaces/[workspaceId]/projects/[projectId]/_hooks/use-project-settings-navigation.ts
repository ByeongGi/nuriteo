"use client";

import { usePathname } from "next/navigation";

export function useProjectSettingsNavigation() {
  const pathname = usePathname();

  function isCurrentDestination(href: string): boolean {
    return pathname === href;
  }

  return { isCurrentDestination };
}
