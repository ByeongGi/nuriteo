import { forwardCollaborationMutation } from "../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "GET", path: "/api/v1/access-tokens", requireCsrf: false, withBody: false
  });
}

export function POST(request: Request) {
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: true,
    method: "POST",
    path: "/api/v1/access-tokens",
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 4_096
  });
}
