import "server-only";

import {
  forwardCollaborationMutation,
  invalidCollaborationRoute
} from "./collaboration-bff.ts";

const AUDIT_PATH = "/api/v1/admin/audit-events" as const;
const MAX_QUERY_BYTES = 4_096;
const MAX_FILTER_BYTES = 512;
const textEncoder = new TextEncoder();
const FILTERS = [
  "from",
  "to",
  "actorType",
  "actorId",
  "actionCode",
  "result",
  "scopeType",
  "scopeId",
  "targetType",
  "targetId",
  "cursor",
  "limit"
] as const;

export function auditEventListPath(request: Request): `/api/v1/admin/audit-events${string}` | undefined {
  const search = new URL(request.url).search;
  if (textEncoder.encode(search).byteLength > MAX_QUERY_BYTES) return undefined;
  const supplied = new URLSearchParams(search);
  const allowed = new Set<string>(FILTERS);
  for (const key of supplied.keys()) {
    if (!allowed.has(key) || supplied.getAll(key).length !== 1) return undefined;
  }

  const canonical = new URLSearchParams();
  for (const key of FILTERS) {
    const value = supplied.get(key);
    if (value === null) continue;
    if (key === "limit") {
      if (!/^(?:[1-9]|[1-9]\d|100)$/u.test(value)) return undefined;
    } else if (
      value.length === 0 ||
      textEncoder.encode(value).byteLength > MAX_FILTER_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      return undefined;
    }
    canonical.set(key, value);
  }
  const query = canonical.toString();
  return query === "" ? AUDIT_PATH : `${AUDIT_PATH}?${query}`;
}

export function forwardAuditEventList(request: Request): Promise<Response> | Response {
  const path = auditEventListPath(request);
  return path === undefined
    ? invalidCollaborationRoute(request, AUDIT_PATH)
    : forwardCollaborationMutation(request, {
        method: "GET",
        path,
        requireCsrf: false,
        withBody: false
      });
}
