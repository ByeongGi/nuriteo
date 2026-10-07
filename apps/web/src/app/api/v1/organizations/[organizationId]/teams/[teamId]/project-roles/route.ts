import {
  forwardTeamRequest,
  invalidTeamRoute,
  teamChildCollectionPath
} from "../../../../../../../../lib/api/team-bff.ts";

export const dynamic = "force-dynamic";

interface Context { readonly params: Promise<{ organizationId: string; teamId: string }> }

async function pathFor(request: Request, context: Context) {
  const { organizationId, teamId } = await context.params;
  return teamChildCollectionPath(request, organizationId, teamId, "project-roles");
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidTeamRoute(request) : forwardTeamRequest(request, { method: "GET", path });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const path = await pathFor(request, context);
  return path === undefined ? invalidTeamRoute(request) : forwardTeamRequest(request, { method: "POST", path, withBody: true });
}
