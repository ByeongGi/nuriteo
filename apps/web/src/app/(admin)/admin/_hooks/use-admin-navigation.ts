"use client";

import { usePathname } from "next/navigation";

export function useAdminNavigation(pathnameOverride: string | undefined) {
  const currentPathname = usePathname();
  return { pathname: pathnameOverride ?? currentPathname };
}
