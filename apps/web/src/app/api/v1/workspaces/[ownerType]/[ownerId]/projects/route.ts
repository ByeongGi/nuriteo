import { exactProjectListPath, forwardProjectRequest, invalidProjectRoute, projectOwnerPath } from "../../../../../../../lib/api/project-bff.ts";

interface Context { readonly params: Promise<{ ownerId: string; ownerType: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  const { ownerId, ownerType } = await context.params;
  const owner = projectOwnerPath(ownerType, ownerId);
  const path = owner === undefined ? undefined : exactProjectListPath(request, `${owner}/projects`, true);
  return path === undefined ? invalidProjectRoute(request) : forwardProjectRequest(request, { method: "GET", path });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { ownerId, ownerType } = await context.params;
  const owner = projectOwnerPath(ownerType, ownerId);
  if (owner === undefined || new URL(request.url).search !== "") return invalidProjectRoute(request);
  const collection = `${owner}/projects` as const;
  return forwardProjectRequest(request, { method: "POST", path: collection, withBody: true, locationPrefix: collection });
}
