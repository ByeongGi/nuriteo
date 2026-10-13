import "server-only";

import {
  exactProjectListPath,
  forwardProjectRequest,
  hasNoProjectQuery,
  invalidProjectRoute,
  projectItemPath
} from "./project-bff.ts";

export interface HistoryRouteContext {
  readonly ownerType: string;
  readonly ownerId: string;
  readonly projectId: string;
}

export function forwardProjectHistoryRequest(
  request: Request,
  context: HistoryRouteContext,
  action: "versions" | "recovery" | "restore"
): Promise<Response> | Response {
  const project = projectItemPath(context.ownerType, context.ownerId, context.projectId);
  if (project === undefined) return invalidProjectRoute(request);

  if (action === "versions") {
    if (request.method === "GET") {
      const path = exactProjectListPath(request, `${project}/versions`, false);
      return path === undefined
        ? invalidProjectRoute(request)
        : forwardProjectRequest(request, { method: "GET", path });
    }
    if (request.method === "POST" && hasNoProjectQuery(request)) {
      return forwardProjectRequest(request, {
        method: "POST",
        path: `${project}/versions`,
        withBody: true,
        withEtag: true,
        withIdempotencyKey: true,
        maxBodyBytes: 4_096
      });
    }
    return invalidProjectRoute(request);
  }

  if (!hasNoProjectQuery(request)) return invalidProjectRoute(request);
  if (action === "recovery") {
    return request.method === "GET"
      ? forwardProjectRequest(request, { method: "GET", path: `${project}/recovery-checkpoints` })
      : invalidProjectRoute(request);
  }

  if (request.method === "GET") {
    return forwardProjectRequest(request, {
      method: "GET",
      path: `${project}/history/restore`,
      withIdempotencyKey: true
    });
  }
  if (request.method === "POST") {
    return forwardProjectRequest(request, {
      method: "POST",
      path: `${project}/history/restore`,
      withBody: true,
      withEtag: true,
      withIdempotencyKey: true,
      maxBodyBytes: 4_096
    });
  }
  return invalidProjectRoute(request);
}
