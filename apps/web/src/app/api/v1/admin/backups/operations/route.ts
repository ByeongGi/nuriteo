import { forwardCollaborationMutation, invalidCollaborationRoute, uuidPathSegment } from "#src/lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const supplied = new URL(request.url).searchParams;
  for (const key of supplied.keys()) if (!new Set(["cursor", "limit"]).has(key) || supplied.getAll(key).length !== 1) return invalidCollaborationRoute(request);
  const query = new URLSearchParams();
  const cursor = supplied.get("cursor");
  if (cursor !== null) {
    const safeCursor = uuidPathSegment(cursor);
    if (safeCursor === undefined) return invalidCollaborationRoute(request);
    query.set("cursor", safeCursor);
  }
  const limit = supplied.get("limit");
  if (limit !== null) {
    if (!/^(?:[1-9]|[1-9]\d|100)$/u.test(limit)) return invalidCollaborationRoute(request);
    query.set("limit", limit);
  }
  return forwardCollaborationMutation(request, { method: "GET", path: `/api/v1/admin/backups/operations${query.size === 0 ? "" : `?${query.toString()}`}`, requireCsrf: false, withBody: false });
}

export function POST(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: "/api/v1/admin/backups/operations",
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 1_024,
    commitOutcomeUnknown: true
  });
}
