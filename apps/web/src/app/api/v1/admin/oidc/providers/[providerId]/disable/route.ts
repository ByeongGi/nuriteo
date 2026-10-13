import { forwardCollaborationMutation, invalidCollaborationRoute, uuidPathSegment } from "../../../../../../../../lib/api/collaboration-bff.ts";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  const providerId = uuidPathSegment((await params).providerId); if (providerId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, { method: "POST", path: `/api/v1/admin/oidc/providers/${providerId}/disable`, requireCsrf: true, withBody: false, withEtag: true, etagKind: "oidc-provider", commitOutcomeUnknown: true });
}
