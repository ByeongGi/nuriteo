import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ tokenId: string }> }) {
  const tokenId = uuidPathSegment((await context.params).tokenId);
  if (tokenId === undefined) return invalidCollaborationRoute(request, "/api/v1/access-tokens");
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: true,
    method: "POST",
    path: `/api/v1/access-tokens/${tokenId}/rotate`,
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 4_096
  });
}
