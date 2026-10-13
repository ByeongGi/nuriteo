import { forwardCollaborationMutation, invalidCollaborationRoute, uuidPathSegment } from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";
export async function DELETE(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  const providerId = uuidPathSegment((await params).providerId);
  if (providerId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, { method: "DELETE", path: `/api/v1/me/oidc-identities/${providerId}`, requireCsrf: true, withBody: false, forwardSetCookie: true });
}
