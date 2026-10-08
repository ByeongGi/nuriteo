import {
  forwardCollaborationMutation,
  invalidCollaborationRoute
} from "../../../../../../../../lib/api/collaboration-bff.ts";
import {
  publicIdPathSegment,
  publicVersionPathSegment
} from "../../../../../../../../lib/published-example-path.ts";

interface Context {
  readonly params: Promise<{
    readonly publicId: string;
    readonly versionNumber: string;
  }>;
}

const PROJECT_LOCATION = /^\/api\/v1\/workspaces\/(?:users|organizations)\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/projects\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function POST(request: Request, context: Context): Promise<Response> {
  const { publicId, versionNumber } = await context.params;
  const safePublicId = publicIdPathSegment(publicId);
  const safeVersion = publicVersionPathSegment(versionNumber);
  if (
    safePublicId === undefined ||
    safeVersion === undefined ||
    new URL(request.url).search !== ""
  ) {
    return invalidCollaborationRoute(request, "/api/v1/published-examples/versions/forks");
  }
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: true,
    method: "POST",
    path: `/api/v1/published-examples/${safePublicId}/versions/${safeVersion}/forks`,
    requireCsrf: true,
    safeLocation: (value) => PROJECT_LOCATION.test(value),
    withBody: true,
    withIdempotencyKey: true
  });
}
