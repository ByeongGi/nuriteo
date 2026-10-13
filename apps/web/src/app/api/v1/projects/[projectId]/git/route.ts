import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ projectId: string }> }
) {
  const projectId = uuidPathSegment((await context.params).projectId);
  if (projectId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "GET",
    path: `/api/v1/projects/${projectId}/git`,
    requireCsrf: false,
    withBody: false
  });
}
