import { forwardProjectRequest, hasNoProjectQuery, invalidProjectRoute, projectItemPath } from "../../../../../../../../../lib/api/project-bff.ts";

interface Context { readonly params: Promise<{ action: string; ownerId: string; ownerType: string; projectId: string }> }

export async function POST(request: Request, context: Context): Promise<Response> {
  const { action, ownerId, ownerType, projectId } = await context.params;
  const project = projectItemPath(ownerType, ownerId, projectId);
  const path = project !== undefined && (action === "archive" || action === "restore") ? `${project}/${action}` as const : undefined;
  return path === undefined || !hasNoProjectQuery(request) ? invalidProjectRoute(request) : forwardProjectRequest(request, { method: "POST", path, withEtag: true });
}
