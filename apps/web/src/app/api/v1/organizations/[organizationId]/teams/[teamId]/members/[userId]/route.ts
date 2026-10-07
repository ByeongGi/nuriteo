import {
  forwardTeamRequest,
  invalidTeamRoute,
  teamChildItemPath
} from "../../../../../../../../../lib/api/team-bff.ts";

export const dynamic = "force-dynamic";

interface Context { readonly params: Promise<{ organizationId: string; teamId: string; userId: string }> }

async function pathFor(request: Request, context: Context) {
  const { organizationId, teamId, userId } = await context.params;
  return teamChildItemPath(request, organizationId, teamId, "members", userId);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidTeamRoute(request) : forwardTeamRequest(request, { etagKind: "team-member", method: "PATCH", path, withBody: true });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidTeamRoute(request) : forwardTeamRequest(request, { etagKind: "team-member", method: "DELETE", path });
}
