import {
  type ApiResult,
  type DomainRequestOptions,
  validatedResult
} from "./domain.ts";
import type { ApiClient } from "./types.ts";
import {
  readBoundedArray,
  readBoundedString,
  readExactRecord,
  readUuidV7
} from "./validation.ts";

const MAX_WORKSPACES = 128;

export type Workspace = PersonalWorkspace | OrganizationWorkspace;
export type WorkspaceOwnerType = Workspace["ownerType"];

interface WorkspaceBase {
  readonly ownerId: string;
  readonly displayLabel: string;
  readonly storageScopeId: string;
}

export interface PersonalWorkspace extends WorkspaceBase {
  readonly ownerType: "user";
}

export interface OrganizationWorkspace extends WorkspaceBase {
  readonly ownerType: "organization";
}

export interface WorkspaceCollection {
  readonly workspaces: readonly Workspace[];
}

export async function getCurrentWorkspaces(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<WorkspaceCollection>> {
  const response = await client.get<unknown>("/me/workspaces", options);
  return validatedResult(response, parseWorkspaceCollection);
}

function parseWorkspaceCollection(value: unknown): WorkspaceCollection {
  const root = readExactRecord(value, ["workspaces"]);
  return {
    workspaces: readBoundedArray(root, "workspaces", MAX_WORKSPACES).map(parseWorkspace)
  };
}

function parseWorkspace(value: unknown): Workspace {
  const workspace = readExactRecord(value, [
    "displayLabel",
    "ownerId",
    "ownerType",
    "storageScopeId"
  ]);
  const ownerType = readBoundedString(workspace, "ownerType", 32);
  if (ownerType !== "user" && ownerType !== "organization") {
    throw new TypeError("invalid Workspace owner type");
  }
  return {
    ownerType,
    ownerId: readUuidV7(workspace, "ownerId"),
    displayLabel: readBoundedString(workspace, "displayLabel", 800, {
      maxCharacters: 200
    }),
    storageScopeId: readUuidV7(workspace, "storageScopeId")
  };
}
