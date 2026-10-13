import {
  forwardTeamRequest,
  invalidTeamRoute,
  teamCollectionPath,
  teamLocation
} from "../../../../../../lib/api/team-bff.ts";

export const dynamic = "force-dynamic";

interface Context { readonly params: Promise<{ organizationId: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  const { organizationId } = await context.params;
  const path = teamCollectionPath(request, organizationId);
  return path === undefined
    ? invalidTeamRoute(request)
    : forwardTeamRequest(request, { method: "GET", path });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { organizationId } = await context.params;
  const path = teamCollectionPath(request, organizationId);
  return path === undefined
    ? invalidTeamRoute(request)
    : forwardTeamRequest(request, {
        method: "POST",
        path,
        safeLocation: teamLocation(organizationId),
        withBody: true
      });
}
