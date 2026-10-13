import { forwardCollaborationMutation } from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return forwardCollaborationMutation(request, { method: "POST", path: "/api/v1/mfa/enrollment/confirm", requireCsrf: true, withBody: true, maxBodyBytes: 2_048, forwardSetCookie: true, withIdempotencyKey: true, commitOutcomeUnknown: true });
}
