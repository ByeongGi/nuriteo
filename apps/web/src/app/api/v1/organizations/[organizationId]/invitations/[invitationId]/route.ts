import {
  forwardCollaborationMutation,
  uuidPathSegment
} from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ organizationId: string; invitationId: string }> }
) {
  const { organizationId, invitationId } = await params;
  return forwardCollaborationMutation(request, {
    method: "DELETE",
    path: `/api/v1/organizations/${uuidPathSegment(organizationId)}/invitations/${uuidPathSegment(invitationId)}`,
    requireCsrf: true,
    withBody: false
  });
}
