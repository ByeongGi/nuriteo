import {
  forwardCollaborationMutation,
  uuidPathSegment
} from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> }
) {
  const { organizationId } = await params;
  return forwardCollaborationMutation(request, {
    method: "PATCH",
    path: `/api/v1/organizations/${uuidPathSegment(organizationId)}`,
    requireCsrf: true,
    withBody: true,
    withEtag: true
  });
}
