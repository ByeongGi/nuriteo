import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(
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
    method: "POST",
    path: `/api/v1/organizations/${safeOrganizationId}/invitations/${safeInvitationId}/reissue`,
    requireCsrf: true,
    withBody: true
  });
}
