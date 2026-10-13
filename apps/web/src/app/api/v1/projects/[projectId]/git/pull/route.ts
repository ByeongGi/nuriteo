import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ projectId: string }> }
) {
  const projectId = uuidPathSegment((await context.params).projectId);
  if (projectId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: true,
    etagKind: "git-remote",
    method: "POST",
    path: `/api/v1/projects/${projectId}/git/pull`,
    requireCsrf: true,
    withBody: false,
    withEtag: true
  });
}
