import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

interface Context { params: Promise<{ organizationId: string; userId: string }> }

function path(organizationId: string, userId: string) {
  const safeOrganizationId = uuidPathSegment(organizationId);
  const safeUserId = uuidPathSegment(userId);
  return safeOrganizationId === undefined || safeUserId === undefined
    ? undefined
    : `/api/v1/organizations/${safeOrganizationId}/members/${safeUserId}` as const;
}

export async function PATCH(request: Request, { params }: Context) {
  const { organizationId, userId } = await params;
  const routePath = path(organizationId, userId);
  if (routePath === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "PATCH", path: routePath, requireCsrf: true, withBody: true
  });
}

export async function DELETE(request: Request, { params }: Context) {
  const { organizationId, userId } = await params;
  const routePath = path(organizationId, userId);
  if (routePath === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "DELETE", path: routePath, requireCsrf: true, withBody: false
  });
}
