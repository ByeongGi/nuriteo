import "server-only";

import { forwardProjectRequest, hasNoProjectQuery, invalidProjectRoute, projectSaveSessionPath } from "./project-bff.ts";

export interface SaveRouteContext {
  readonly ownerType: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly sessionId?: string;
}

export function forwardSaveSessionRequest(
  request: Request,
  context: SaveRouteContext,
  action: "create" | "parts" | "receipts" | "complete" | "reconcile" | "abort"
): Promise<Response> | Response {
  const session = projectSaveSessionPath(
    context.ownerType,
    context.ownerId,
    context.projectId,
    context.sessionId
  );
  if (session === undefined || !hasNoProjectQuery(request)) return invalidProjectRoute(request);
  const suffix = action === "parts" ? "/parts"
    : action === "receipts" ? "/parts/receipts"
      : action === "complete" || action === "reconcile" ? `/${action}` : "";
  const method = action === "abort" ? "DELETE" : "POST";
  if (request.method !== method) return invalidProjectRoute(request);
  return forwardProjectRequest(request, {
    method,
    path: `${session}${suffix}` as `/api/v1/workspaces/${string}`,
    withBody: action === "create" || action === "parts" || action === "receipts" || action === "complete",
    ...(action === "create" ? { maxBodyBytes: 65_536 } : {}),
    withEtag: action === "create",
    withIdempotencyKey: action === "create"
  });
}
