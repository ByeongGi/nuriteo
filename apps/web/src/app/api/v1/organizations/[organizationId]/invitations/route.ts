import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> }
) {
  const { organizationId } = await params;
  const safeOrganizationId = uuidPathSegment(organizationId);
  if (safeOrganizationId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    jsonBodyPolicy: "organization-invitation-issue",
    method: "POST",
    path: `/api/v1/organizations/${safeOrganizationId}/invitations`,
    requireCsrf: true,
    withBody: true
  });
}
