import type { Workspace } from "@nuriteo/api-client";

export function resolveWorkspaceSelection(
  workspaces: readonly Workspace[],
  requestedScope: string | readonly string[] | undefined
): string | undefined {
  if (typeof requestedScope === "string") {
    const requested = workspaces.find(
      (workspace) => workspace.storageScopeId === requestedScope
    );
    if (requested !== undefined) {
      return requested.storageScopeId;
    }
  }

  return (
    workspaces.find((workspace) => workspace.ownerType === "user") ?? workspaces[0]
  )?.storageScopeId;
}

export function workspaceOwnerLabel(workspace: Workspace): string {
  return workspace.ownerType === "user" ? "Personal" : "Organization";
}
