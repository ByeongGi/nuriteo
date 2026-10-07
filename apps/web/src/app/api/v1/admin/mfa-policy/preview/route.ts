import { forwardCollaborationMutation } from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: "/api/v1/admin/mfa-policy/preview",
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 2_048,
    withEtag: true,
    etagKind: "mfa-policy"
  });
}
