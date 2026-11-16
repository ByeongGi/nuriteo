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
  return workspace.ownerType === "user" ? "개인" : "조직";
}

export function workspacePlaceLabel(workspace: Workspace): string {
  if (workspace.ownerType === "user") return "개인 작업 공간";
  return "팀과 공유하는 작업 공간";
}
