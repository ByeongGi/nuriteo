import { forwardCollaborationMutation } from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: "/api/v1/admin/activation-invitations",
    requireCsrf: true,
    withBody: true
  });
}
