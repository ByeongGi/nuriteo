import { forwardCollaborationMutation } from "../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("query")?.trim() ?? "";
  if (query.length < 2 || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query)) {
    return Response.json({ code: "INVALID_SEARCH", message: "Enter at least two characters." }, { status: 400 });
  }
  return forwardCollaborationMutation(request, {
    method: "GET",
    path: `/api/v1/admin/mfa-reset-targets?query=${encodeURIComponent(query)}`,
    requireCsrf: false,
    withBody: false
  });
}
