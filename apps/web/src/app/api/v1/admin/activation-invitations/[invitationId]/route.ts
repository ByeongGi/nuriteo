import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ invitationId: string }> }
) {
  const { invitationId } = await params;
  const safeInvitationId = uuidPathSegment(invitationId);
  if (safeInvitationId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "DELETE",
    path: `/api/v1/admin/activation-invitations/${safeInvitationId}`,
    requireCsrf: true,
    withBody: false
  });
}
