import { forwardCollaborationMutation } from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: "/api/v1/admin/registry-scopes",
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 4_096,
    commitOutcomeUnknown: true
  });
}
