import "server-only";

import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "./collaboration-bff.ts";
import { hasNoProjectQuery, projectItemPath } from "./project-bff.ts";

export interface PublishedExampleForward {
  readonly method: "DELETE" | "PATCH" | "POST";
  readonly path: `/api/v1/workspaces/${string}`;
  readonly withBody: boolean;
  readonly withEtag?: boolean;
  readonly createLocationPrefix?: `/api/v1/workspaces/${string}`;
}

export function publishedExampleCollectionPath(
  ownerType: string,
  ownerId: string,
  projectId: string
): `/api/v1/workspaces/${string}` | undefined {
  const project = projectItemPath(ownerType, ownerId, projectId);
  return project === undefined ? undefined : `${project}/published-examples`;
}

export function publishedExampleItemPath(
  ownerType: string,
  ownerId: string,
  projectId: string,
  exampleId: string,
  action?: "active-version" | "republish" | "unpublish" | "versions"
): `/api/v1/workspaces/${string}` | undefined {
  const collection = publishedExampleCollectionPath(ownerType, ownerId, projectId);
  const example = uuidPathSegment(exampleId);
  if (collection === undefined || example === undefined) return undefined;
  const item = `${collection}/${example}` as const;
  return action === undefined ? item : `${item}/${action}`;
}

export function exactPublishedExamplePath(
  request: Request,
  path: `/api/v1/workspaces/${string}` | undefined
): `/api/v1/workspaces/${string}` | undefined {
  return path !== undefined && hasNoProjectQuery(request) ? path : undefined;
}

export function invalidPublishedExampleRoute(request: Request): Response {
  return invalidCollaborationRoute(request, "/api/v1/workspaces/projects/published-examples");
}

export function forwardPublishedExampleRequest(
  request: Request,
  spec: PublishedExampleForward
): Promise<Response> {
  const createLocationPrefix = spec.createLocationPrefix;
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: true,
    method: spec.method,
    path: spec.path,
    requireCsrf: true,
    withBody: spec.withBody,
    ...(spec.withEtag ? { withEtag: true, etagKind: "published-example" as const } : {}),
    ...(createLocationPrefix === undefined ? {} : {
      safeLocation: (value: string) => {
        if (!value.startsWith(`${createLocationPrefix}/`)) return false;
        return uuidPathSegment(value.slice(createLocationPrefix.length + 1)) !== undefined;
      }
    })
  });
}
