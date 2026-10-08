import { forwardCollaborationMutation, invalidCollaborationRoute, uuidPathSegment } from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";
async function provider(request: Request, params: Promise<{ providerId: string }>, method: "DELETE" | "PATCH") {
  const providerId = uuidPathSegment((await params).providerId);
  if (providerId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, { method, path: `/api/v1/admin/oidc/providers/${providerId}`, requireCsrf: true, withBody: method === "PATCH", withEtag: true, etagKind: "oidc-provider", maxBodyBytes: 4_096, commitOutcomeUnknown: true });
}
export function PATCH(request: Request, { params }: { params: Promise<{ providerId: string }> }) { return provider(request, params, "PATCH"); }
export function DELETE(request: Request, { params }: { params: Promise<{ providerId: string }> }) { return provider(request, params, "DELETE"); }
