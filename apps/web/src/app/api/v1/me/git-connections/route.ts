import { forwardCollaborationMutation } from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "GET",
    path: "/api/v1/me/git-connections",
    requireCsrf: false,
    withBody: false
  });
}

export function POST(request: Request) {
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: true,
    maxBodyBytes: 65_536,
    method: "POST",
    path: "/api/v1/me/git-connections",
    requireCsrf: true,
    withBody: true
  });
}
