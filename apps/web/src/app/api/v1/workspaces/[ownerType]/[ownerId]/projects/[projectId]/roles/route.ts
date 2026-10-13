import { exactProjectListPath, forwardProjectRequest, hasNoProjectQuery, invalidProjectRoute, projectRolePath } from "../../../../../../../../../lib/api/project-bff.ts";

interface Context { readonly params: Promise<{ ownerId: string; ownerType: string; projectId: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  const { ownerId, ownerType, projectId } = await context.params;
  const collection = projectRolePath(ownerType, ownerId, projectId);
  const path = collection === undefined ? undefined : exactProjectListPath(request, collection, false);
  return path === undefined ? invalidProjectRoute(request) : forwardProjectRequest(request, { method: "GET", path });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { ownerId, ownerType, projectId } = await context.params;
  const path = projectRolePath(ownerType, ownerId, projectId);
  return path === undefined || !hasNoProjectQuery(request) ? invalidProjectRoute(request) : forwardProjectRequest(request, { method: "POST", path, withBody: true, withEtag: true });
}
