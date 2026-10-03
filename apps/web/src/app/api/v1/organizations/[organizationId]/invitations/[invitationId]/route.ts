import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ organizationId: string; invitationId: string }> }
) {
  const { organizationId, invitationId } = await params;
  const safeOrganizationId = uuidPathSegment(organizationId);
  const safeInvitationId = uuidPathSegment(invitationId);
  if (safeOrganizationId === undefined || safeInvitationId === undefined) {
    return invalidCollaborationRoute(request);
  }
  return forwardCollaborationMutation(request, {
    method: "DELETE",
    path: `/api/v1/organizations/${safeOrganizationId}/invitations/${safeInvitationId}`,
    requireCsrf: true,
    withBody: false
  });
}
