import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ notificationId: string }> }
) {
  const notificationId = uuidPathSegment((await params).notificationId);
  if (notificationId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "PATCH",
    path: `/api/v1/notifications/${notificationId}`,
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 2_048,
    withEtag: true,
    etagKind: "notification"
  });
}
