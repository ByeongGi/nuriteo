import { forwardCollaborationMutation } from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return forwardCollaborationMutation(request, {
    method: "GET",
    path: "/api/v1/me/workspaces",
    requireCsrf: false,
    withBody: false
  });
}
