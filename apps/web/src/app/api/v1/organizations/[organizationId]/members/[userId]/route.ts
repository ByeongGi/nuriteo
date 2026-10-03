import {
  forwardCollaborationMutation,
  uuidPathSegment
} from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

interface Context { params: Promise<{ organizationId: string; userId: string }> }

function path(organizationId: string, userId: string) {
  return `/api/v1/organizations/${uuidPathSegment(organizationId)}/members/${uuidPathSegment(userId)}` as const;
}

export async function PATCH(request: Request, { params }: Context) {
  const { organizationId, userId } = await params;
  return forwardCollaborationMutation(request, {
    method: "PATCH", path: path(organizationId, userId), requireCsrf: true, withBody: true
  });
}

export async function DELETE(request: Request, { params }: Context) {
  const { organizationId, userId } = await params;
  return forwardCollaborationMutation(request, {
    method: "DELETE", path: path(organizationId, userId), requireCsrf: true, withBody: false
  });
}
