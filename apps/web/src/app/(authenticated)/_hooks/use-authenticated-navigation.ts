"use client";

import { usePathname } from "next/navigation";

import type { Workspace } from "@nuriteo/api-client";

export function useAuthenticatedNavigation(
  pathnameOverride: string | undefined,
  workspaces: readonly Workspace[]
) {
  const currentPathname = usePathname();
  const pathname = pathnameOverride ?? currentPathname;
  const pathScope = /^\/workspaces\/([^/]+)/u.exec(pathname)?.[1];
  const requestedScope = pathScope === undefined ? undefined : decodeURIComponent(pathScope);
  const activeWorkspace = workspaces.find((workspace) => workspace.storageScopeId === requestedScope);
  const activeScope = activeWorkspace?.storageScopeId;
  const workspaceBaseHref = activeScope === undefined
    ? "/workspaces"
    : `/workspaces/${encodeURIComponent(activeScope)}`;

  return { activeWorkspace, pathname, workspaceBaseHref };
}
