import "server-only";

import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "./collaboration-bff.ts";

const MAX_CURSOR_BYTES = 2_048;
const MAX_QUERY_BYTES = 4_096;
const textEncoder = new TextEncoder();

export type ProjectOwnerSegment = "organizations" | "users";

export interface ProjectForward {
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  readonly maxBodyBytes?: number;
  readonly path: `/api/v1/workspaces/${string}`;
  readonly withBody?: boolean;
  readonly withEtag?: boolean;
  readonly withIdempotencyKey?: boolean;
  readonly locationPrefix?: string;
}

export function projectOwnerPath(
  ownerType: string,
  ownerId: string
): `/api/v1/workspaces/${ProjectOwnerSegment}/${string}` | undefined {
  if (ownerType !== "users" && ownerType !== "organizations") return undefined;
  const safeOwnerId = uuidPathSegment(ownerId);
  return safeOwnerId === undefined
    ? undefined
    : `/api/v1/workspaces/${ownerType}/${safeOwnerId}`;
}

export function projectItemPath(
  ownerType: string,
  ownerId: string,
  projectId: string
): `/api/v1/workspaces/${string}` | undefined {
  const owner = projectOwnerPath(ownerType, ownerId);
  const project = uuidPathSegment(projectId);
  return owner === undefined || project === undefined
    ? undefined
    : `${owner}/projects/${project}`;
}

export function projectRolePath(
  ownerType: string,
  ownerId: string,
  projectId: string,
  userId?: string
): `/api/v1/workspaces/${string}` | undefined {
  if (ownerType !== "organizations") return undefined;
  const project = projectItemPath(ownerType, ownerId, projectId);
  if (project === undefined) return undefined;
  if (userId === undefined) return `${project}/roles`;
  const user = uuidPathSegment(userId);
  return user === undefined ? undefined : `${project}/roles/${user}`;
}

export function projectContentPath(
  ownerType: string,
  ownerId: string,
  projectId: string,
  bundleId?: string
): `/api/v1/workspaces/${string}` | undefined {
  const project = projectItemPath(ownerType, ownerId, projectId);
  if (project === undefined) return undefined;
  if (bundleId === undefined) return `${project}/content`;
  const bundle = uuidPathSegment(bundleId);
  return bundle === undefined ? undefined : `${project}/content/${bundle}`;
}

export function exactProjectListPath(
  request: Request,
  collection: `/api/v1/workspaces/${string}`,
  allowState: boolean
): `/api/v1/workspaces/${string}` | undefined {
  const search = new URL(request.url).search;
  if (textEncoder.encode(search).byteLength > MAX_QUERY_BYTES) return undefined;
  const supplied = new URLSearchParams(search);
  const canonical = new URLSearchParams();
  const allowed = new Set(allowState ? ["state", "pageSize", "cursor"] : ["pageSize", "cursor"]);
  for (const key of supplied.keys()) {
    if (!allowed.has(key) || supplied.getAll(key).length !== 1) return undefined;
  }
  const state = supplied.get("state");
  if (state !== null) {
    if (!allowState || !["active", "archived", "all"].includes(state)) return undefined;
    canonical.set("state", state);
  }
  const pageSize = supplied.get("pageSize");
  if (pageSize !== null) {
    if (!/^(?:[1-9]|[1-9]\d|100)$/u.test(pageSize)) return undefined;
    canonical.set("pageSize", pageSize);
  }
  const cursor = supplied.get("cursor");
  if (cursor !== null) {
    if (
      cursor.length === 0 ||
      textEncoder.encode(cursor).byteLength > MAX_CURSOR_BYTES ||
      /[\u0000-\u0020\u007f]/u.test(cursor)
    ) return undefined;
    canonical.set("cursor", cursor);
  }
  const query = canonical.toString();
  return query.length === 0 ? collection : `${collection}?${query}`;
}

export function hasNoProjectQuery(request: Request): boolean {
  return new URL(request.url).search === "";
}

export function invalidProjectRoute(request: Request): Response {
  return invalidCollaborationRoute(request, "/api/v1/workspaces/projects");
}

export function forwardProjectRequest(request: Request, spec: ProjectForward): Promise<Response> {
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: spec.method !== "GET",
    method: spec.method,
    ...(spec.maxBodyBytes === undefined ? {} : { maxBodyBytes: spec.maxBodyBytes }),
    path: spec.path,
    requireCsrf: spec.method !== "GET",
    withBody: spec.withBody ?? false,
    ...(spec.withEtag ? { withEtag: true, etagKind: "project" as const } : {}),
    ...(spec.withIdempotencyKey ? { withIdempotencyKey: true } : {}),
    ...(spec.locationPrefix === undefined ? {} : {
      safeLocation: (value: string) => {
        const suffix = value.slice(spec.locationPrefix!.length);
        return value.startsWith(spec.locationPrefix!) &&
          /^\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(suffix);
      }
    })
  });
}

export function projectSaveSessionPath(
  ownerType: string,
  ownerId: string,
  projectId: string,
  sessionId?: string
): `/api/v1/workspaces/${string}` | undefined {
  const project = projectItemPath(ownerType, ownerId, projectId);
  if (project === undefined) return undefined;
  if (sessionId === undefined) return `${project}/save-sessions`;
  const session = uuidPathSegment(sessionId);
  return session === undefined ? undefined : `${project}/save-sessions/${session}`;
}
