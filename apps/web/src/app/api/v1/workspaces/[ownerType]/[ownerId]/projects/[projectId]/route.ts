import { forwardProjectRequest, hasNoProjectQuery, invalidProjectRoute, projectItemPath } from "../../../../../../../../lib/api/project-bff.ts";

interface Context { readonly params: Promise<{ ownerId: string; ownerType: string; projectId: string }> }

async function pathFor(request: Request, context: Context) {
  const { ownerId, ownerType, projectId } = await context.params;
  return hasNoProjectQuery(request) ? projectItemPath(ownerType, ownerId, projectId) : undefined;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidProjectRoute(request) : forwardProjectRequest(request, { method: "GET", path });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidProjectRoute(request) : forwardProjectRequest(request, { method: "PATCH", path, withBody: true, withEtag: true });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidProjectRoute(request) : forwardProjectRequest(request, { method: "DELETE", path, withBody: true, withEtag: true });
}
