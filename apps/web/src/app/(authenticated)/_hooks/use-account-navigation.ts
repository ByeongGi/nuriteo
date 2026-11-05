"use client";

import { usePathname } from "next/navigation";

export function useAccountNavigation() {
  const pathname = usePathname();

  function isCurrent(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return { isCurrent };
}
