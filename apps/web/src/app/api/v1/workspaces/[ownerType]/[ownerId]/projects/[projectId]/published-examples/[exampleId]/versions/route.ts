import {
  exactPublishedExamplePath,
  forwardPublishedExampleRequest,
  invalidPublishedExampleRoute,
  publishedExampleItemPath
} from "../../../../../../../../../../../lib/api/published-example-management-bff.ts";

interface Context {
  readonly params: Promise<{
    exampleId: string;
    ownerId: string;
    ownerType: string;
    projectId: string;
  }>;
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { exampleId, ownerId, ownerType, projectId } = await context.params;
  const path = exactPublishedExamplePath(
    request,
    publishedExampleItemPath(ownerType, ownerId, projectId, exampleId, "versions")
  );
  return path === undefined
    ? invalidPublishedExampleRoute(request)
    : forwardPublishedExampleRequest(request, {
        method: "POST",
        path,
        withBody: true,
        withEtag: true
      });
}
