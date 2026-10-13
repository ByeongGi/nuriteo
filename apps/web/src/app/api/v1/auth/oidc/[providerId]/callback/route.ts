import { forwardOidcNavigation, invalidCollaborationRoute, uuidPathSegment } from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  const providerId = uuidPathSegment((await params).providerId);
  if (providerId === undefined) return invalidCollaborationRoute(request);
  const incoming = new URL(request.url);
  const values = Object.fromEntries(["iss", "state", "code"].map((key) => [key, incoming.searchParams.getAll(key)]));
  if (Object.values(values).some((items) => items.length !== 1) || values.iss![0]!.length > 2_048 || values.state![0]!.length > 512 || values.code![0]!.length > 4_096) {
    return invalidCollaborationRoute(request);
  }
  const query = new URLSearchParams({ iss: values.iss![0]!, state: values.state![0]!, code: values.code![0]! });
  return forwardOidcNavigation(request, `/api/v1/auth/oidc/${providerId}/callback?${query}`, "application");
}
