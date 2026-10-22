import { forwardProjectContentDownload } from "#src/lib/api/content-bff.ts";
import { hasNoProjectQuery, invalidProjectRoute, projectContentPath } from "#src/lib/api/project-bff.ts";

interface Context {
  readonly params: Promise<{
    action: string;
    bundleId: string;
    ownerId: string;
    ownerType: string;
    projectId: string;
  }>;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const { action, bundleId, ownerId, ownerType, projectId } = await context.params;
  const path = action === "content"
    ? projectContentPath(ownerType, ownerId, projectId, bundleId)
    : undefined;
  return path === undefined || !hasNoProjectQuery(request)
    ? invalidProjectRoute(request)
    : forwardProjectContentDownload(request, path);
}
