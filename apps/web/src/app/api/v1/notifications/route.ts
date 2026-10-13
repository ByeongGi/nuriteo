import { forwardCollaborationMutation, invalidCollaborationRoute } from "../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url);
  if (!validInboxQuery(url.searchParams)) return invalidCollaborationRoute(request, "/api/v1/notifications");
  const query = url.searchParams.toString();
  const path = `/api/v1/notifications${query.length === 0 ? "" : `?${query}`}` as const;
  return forwardCollaborationMutation(request, { method: "GET", path, requireCsrf: false, withBody: false });
}

function validInboxQuery(parameters: URLSearchParams) {
  if ([...parameters.keys()].some((key) => !["archived", "cursor", "limit"].includes(key))) return false;
  if ([...parameters.keys()].some((key) => parameters.getAll(key).length !== 1)) return false;
  const archived = parameters.get("archived");
  const cursor = parameters.get("cursor");
  const limit = parameters.get("limit");
  return (archived === null || archived === "true" || archived === "false")
    && (cursor === null || /^[A-Za-z0-9_-]{1,2048}$/u.test(cursor))
    && (limit === null || /^(?:[1-9]|[1-9]\d|100)$/u.test(limit));
}
