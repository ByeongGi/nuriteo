import { forwardOidcNavigation, invalidCollaborationRoute, uuidPathSegment } from "#src/lib/api/collaboration-bff.ts";
import { copyResponse, issueOidcReturnToCookie } from "@/app/(public)/sign-in/_utils/oidc-return-to.ts";
import { safeReturnTo } from "@/app/(public)/sign-in/_utils/return-to.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  const providerId = uuidPathSegment((await params).providerId);
  if (providerId === undefined) return invalidCollaborationRoute(request);
  const incoming = new URL(request.url);
  const returnToValues = incoming.searchParams.getAll("returnTo");
  if (returnToValues.length > 1 || (returnToValues[0]?.length ?? 0) > 2_048) {
    return invalidCollaborationRoute(request);
  }
  const returnTo = safeReturnTo(returnToValues[0]);
  const response = await forwardOidcNavigation(request, `/api/v1/auth/oidc/${providerId}/begin`, "provider");
  if (response.status !== 303 || response.headers.get("location")?.startsWith("https://") !== true) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", issueOidcReturnToCookie(request, returnTo));
  return copyResponse(response, headers);
}
