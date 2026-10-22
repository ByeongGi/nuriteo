import { forwardAuditEventList } from "#src/lib/api/audit-bff.ts";

export function GET(request: Request): Promise<Response> | Response {
  return forwardAuditEventList(request);
}
