import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> }
) {
  const { organizationId } = await params;
  const safeOrganizationId = uuidPathSegment(organizationId);
  if (safeOrganizationId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "PATCH",
    path: `/api/v1/organizations/${safeOrganizationId}`,
    requireCsrf: true,
    withBody: true,
    withEtag: true
  });
}
