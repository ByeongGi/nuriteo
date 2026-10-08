import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ connectionId: string }> }
) {
  const connectionId = uuidPathSegment((await context.params).connectionId);
  if (connectionId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: true,
    etagKind: "git-connection",
    maxBodyBytes: 65_536,
    method: "POST",
    path: `/api/v1/me/git-connections/${connectionId}/rotate`,
    requireCsrf: true,
    withBody: true,
    withEtag: true
  });
}
