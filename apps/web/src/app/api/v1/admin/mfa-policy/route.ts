import { forwardCollaborationMutation } from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return forwardCollaborationMutation(request, { method: "GET", path: "/api/v1/admin/mfa-policy", requireCsrf: false, withBody: false });
}

export function PATCH(request: Request) {
  return forwardCollaborationMutation(request, { method: "PATCH", path: "/api/v1/admin/mfa-policy", requireCsrf: true, withBody: true, maxBodyBytes: 2_048, withEtag: true, etagKind: "mfa-policy" });
}

