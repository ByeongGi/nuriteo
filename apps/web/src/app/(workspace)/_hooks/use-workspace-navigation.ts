"use client";

import { usePathname } from "next/navigation";

interface WorkspaceNavigationItem {
  readonly href: string;
  readonly projectRoot?: boolean;
}

export function useWorkspaceNavigation(base: string) {
  const pathname = usePathname();

  function isCurrentDestination(item: WorkspaceNavigationItem): boolean {
    if (item.projectRoot === true) {
      return pathname === base || pathname.startsWith(`${base}/projects`);
    }
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  return { isCurrentDestination };
}
