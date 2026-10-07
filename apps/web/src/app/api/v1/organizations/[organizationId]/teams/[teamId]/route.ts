import {
  forwardTeamRequest,
  invalidTeamRoute,
  teamItemPath
} from "../../../../../../../lib/api/team-bff.ts";

export const dynamic = "force-dynamic";

interface Context { readonly params: Promise<{ organizationId: string; teamId: string }> }

async function pathFor(request: Request, context: Context) {
  const { organizationId, teamId } = await context.params;
  return teamItemPath(request, organizationId, teamId);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidTeamRoute(request) : forwardTeamRequest(request, { method: "GET", path });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidTeamRoute(request) : forwardTeamRequest(request, { etagKind: "team", method: "PATCH", path, withBody: true });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidTeamRoute(request) : forwardTeamRequest(request, { etagKind: "team", method: "DELETE", path });
}
