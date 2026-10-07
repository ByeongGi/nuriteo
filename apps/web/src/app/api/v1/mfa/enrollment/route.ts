import { forwardCollaborationMutation } from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return forwardCollaborationMutation(request, { method: "POST", path: "/api/v1/mfa/enrollment", requireCsrf: true, withBody: false, withIdempotencyKey: true, commitOutcomeUnknown: true });
}

export function DELETE(request: Request) {
  return forwardCollaborationMutation(request, { method: "DELETE", path: "/api/v1/mfa/enrollment", requireCsrf: true, withBody: false, forwardSetCookie: true });
}
