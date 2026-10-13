import { forwardCollaborationMutation } from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "GET",
    path: "/api/v1/admin/status",
    requireCsrf: false,
    withBody: false
  });
}
