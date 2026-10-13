import { forwardOidcNavigation, invalidCollaborationRoute, uuidPathSegment } from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  const providerId = uuidPathSegment((await params).providerId);
  if (providerId === undefined) return invalidCollaborationRoute(request);
  return forwardOidcNavigation(request, `/api/v1/auth/oidc/${providerId}/begin`, "provider");
}
