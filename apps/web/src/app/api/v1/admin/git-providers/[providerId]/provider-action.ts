import { forwardCollaborationMutation, invalidCollaborationRoute, uuidPathSegment } from "../../../../../../lib/api/collaboration-bff.ts";

export async function action(request: Request, params: Promise<{ providerId: string }>, name: "activate" | "disable") {
  const id = uuidPathSegment((await params).providerId);
  if (!id) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, { method: "POST", path: `/api/v1/admin/git-providers/${id}/${name}`, requireCsrf: true, withBody: false, withEtag: true, etagKind: "git-provider", commitOutcomeUnknown: true });
}
