import { forwardCollaborationMutation } from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "GET",
    path: "/api/v1/admin/maintenance",
    requireCsrf: false,
    withBody: false
  });
}

export function PUT(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "PUT",
    path: "/api/v1/admin/maintenance",
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 1_024,
    commitOutcomeUnknown: true
  });
}
