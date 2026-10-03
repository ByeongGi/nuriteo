import {
  forwardCollaborationMutation,
  uuidPathSegment
} from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ invitationId: string }> }
) {
  const { invitationId } = await params;
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: `/api/v1/admin/activation-invitations/${uuidPathSegment(invitationId)}/reissue`,
    requireCsrf: true,
    withBody: true
  });
}
