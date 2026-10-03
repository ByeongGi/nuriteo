import {
  forwardCollaborationMutation,
  uuidPathSegment
} from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> }
) {
  const { organizationId } = await params;
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: `/api/v1/organizations/${uuidPathSegment(organizationId)}/invitations`,
    requireCsrf: true,
    withBody: true
  });
}
