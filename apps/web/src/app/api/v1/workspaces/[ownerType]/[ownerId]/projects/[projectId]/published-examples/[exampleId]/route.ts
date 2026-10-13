import {
  exactPublishedExamplePath,
  forwardPublishedExampleRequest,
  invalidPublishedExampleRoute,
  publishedExampleItemPath
} from "../../../../../../../../../../lib/api/published-example-management-bff.ts";

interface Context {
  readonly params: Promise<{
    exampleId: string;
    ownerId: string;
    ownerType: string;
    projectId: string;
  }>;
}

async function pathFor(request: Request, context: Context) {
  const { exampleId, ownerId, ownerType, projectId } = await context.params;
  return exactPublishedExamplePath(
    request,
    publishedExampleItemPath(ownerType, ownerId, projectId, exampleId)
  );
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined
    ? invalidPublishedExampleRoute(request)
    : forwardPublishedExampleRequest(request, {
        method: "PATCH",
        path,
        withBody: true,
        withEtag: true
      });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined
    ? invalidPublishedExampleRoute(request)
    : forwardPublishedExampleRequest(request, {
        method: "DELETE",
        path,
        withBody: true,
        withEtag: true
      });
}
