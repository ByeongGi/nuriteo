import { forwardCollaborationMutation, invalidCollaborationRoute, uuidPathSegment } from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

async function provider(request: Request, params: Promise<{ providerId: string }>, method: "DELETE" | "PATCH") {
  const id = uuidPathSegment((await params).providerId);
  if (!id) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, { method, path: `/api/v1/admin/git-providers/${id}`, requireCsrf: true, withBody: method === "PATCH", withEtag: true, etagKind: "git-provider", maxBodyBytes: 16_384 });
}
export function PATCH(request: Request, { params }: { params: Promise<{ providerId: string }> }) { return provider(request, params, "PATCH"); }
export function DELETE(request: Request, { params }: { params: Promise<{ providerId: string }> }) { return provider(request, params, "DELETE"); }
