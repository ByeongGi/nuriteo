import {
  exactPublishedExamplePath,
  forwardPublishedExampleRequest,
  invalidPublishedExampleRoute,
  publishedExampleCollectionPath
} from "../../../../../../../../../lib/api/published-example-management-bff.ts";

interface Context {
  readonly params: Promise<{ ownerId: string; ownerType: string; projectId: string }>;
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { ownerId, ownerType, projectId } = await context.params;
  const path = exactPublishedExamplePath(
    request,
    publishedExampleCollectionPath(ownerType, ownerId, projectId)
  );
  return path === undefined
    ? invalidPublishedExampleRoute(request)
    : forwardPublishedExampleRequest(request, {
        createLocationPrefix: path,
        method: "POST",
        path,
        withBody: true
      });
}
