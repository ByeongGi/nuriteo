import { forwardCollaborationMutation, invalidCollaborationRoute } from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url);
  if (!validDeliveryQuery(url.searchParams)) return invalidCollaborationRoute(request, "/api/v1/admin/email-deliveries");
  const query = url.searchParams.toString();
  const path = `/api/v1/admin/email-deliveries${query.length === 0 ? "" : `?${query}`}` as const;
  return forwardCollaborationMutation(request, { method: "GET", path, requireCsrf: false, withBody: false });
}

function validDeliveryQuery(parameters: URLSearchParams) {
  if ([...parameters.keys()].some((key) => !["state", "cursor", "limit"].includes(key))) return false;
  if ([...parameters.keys()].some((key) => parameters.getAll(key).length !== 1)) return false;
  const state = parameters.get("state");
  const cursor = parameters.get("cursor");
  const limit = parameters.get("limit");
  return (state === null || ["pending", "sending", "retry_wait", "sent", "dead_letter", "canceled"].includes(state))
    && (cursor === null || /^[A-Za-z0-9_-]{1,2048}$/u.test(cursor))
    && (limit === null || /^(?:[1-9]|[1-9]\d|100)$/u.test(limit));
}
