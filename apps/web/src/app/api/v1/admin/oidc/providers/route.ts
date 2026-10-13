import { forwardCollaborationMutation } from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return forwardCollaborationMutation(request, { method: "GET", path: "/api/v1/admin/oidc/providers", requireCsrf: false, withBody: false });
}
export function POST(request: Request) {
  return forwardCollaborationMutation(request, { method: "POST", path: "/api/v1/admin/oidc/providers", requireCsrf: true, withBody: true, maxBodyBytes: 4_096, commitOutcomeUnknown: true });
}
