import {
  forwardTeamRequest,
  invalidTeamRoute,
  teamChildItemPath
} from "../../../../../../../../../lib/api/team-bff.ts";

export const dynamic = "force-dynamic";

interface Context { readonly params: Promise<{ organizationId: string; projectId: string; teamId: string }> }

async function pathFor(request: Request, context: Context) {
  const { organizationId, projectId, teamId } = await context.params;
  return teamChildItemPath(request, organizationId, teamId, "project-roles", projectId);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidTeamRoute(request) : forwardTeamRequest(request, { etagKind: "team-project-role", method: "PATCH", path, withBody: true });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidTeamRoute(request) : forwardTeamRequest(request, { etagKind: "team-project-role", method: "DELETE", path });
}
