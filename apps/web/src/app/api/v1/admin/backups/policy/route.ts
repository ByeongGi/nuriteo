import { forwardCollaborationMutation } from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function PUT(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "PUT",
    path: "/api/v1/admin/backups/policy",
    requireCsrf: true,
    withEtag: true,
    etagKind: "backup-policy",
    withBody: true,
    maxBodyBytes: 2_048,
    commitOutcomeUnknown: true
  });
}
