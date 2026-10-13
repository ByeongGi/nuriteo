import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ invitationId: string }> }
) {
  const { invitationId } = await params;
  const safeInvitationId = uuidPathSegment(invitationId);
  if (safeInvitationId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: `/api/v1/admin/activation-invitations/${safeInvitationId}/reissue`,
    requireCsrf: true,
    withBody: true
  });
}
