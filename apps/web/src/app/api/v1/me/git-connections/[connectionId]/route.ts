import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { readonly params: Promise<{ connectionId: string }> }
) {
  const connectionId = uuidPathSegment((await context.params).connectionId);
  if (connectionId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: true,
    etagKind: "git-connection",
    method: "DELETE",
    path: `/api/v1/me/git-connections/${connectionId}`,
    requireCsrf: true,
    withBody: false,
    withEtag: true
  });
}
