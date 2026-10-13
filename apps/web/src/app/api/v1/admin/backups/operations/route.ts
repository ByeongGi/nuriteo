import { forwardCollaborationMutation } from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: "/api/v1/admin/backups/operations",
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 1_024,
    commitOutcomeUnknown: true
  });
}
