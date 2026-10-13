import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; tokenId: string }> }
) {
  const { projectId: rawProjectId, tokenId: rawTokenId } = await context.params;
  const projectId = uuidPathSegment(rawProjectId);
  const tokenId = uuidPathSegment(rawTokenId);
  if (projectId === undefined || tokenId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: true,
    method: "POST",
    path: `/api/v1/projects/${projectId}/access-tokens/${tokenId}/rotate`,
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 4_096
  });
}
