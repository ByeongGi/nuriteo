import { forwardProjectRequest, hasNoProjectQuery, invalidProjectRoute, projectRolePath } from "../../../../../../../../../../lib/api/project-bff.ts";

interface Context { readonly params: Promise<{ ownerId: string; ownerType: string; projectId: string; userId: string }> }

async function pathFor(request: Request, context: Context) {
  const { ownerId, ownerType, projectId, userId } = await context.params;
  return hasNoProjectQuery(request) ? projectRolePath(ownerType, ownerId, projectId, userId) : undefined;
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidProjectRoute(request) : forwardProjectRequest(request, { method: "PATCH", path, withBody: true, withEtag: true });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidProjectRoute(request) : forwardProjectRequest(request, { method: "DELETE", path, withEtag: true });
}
