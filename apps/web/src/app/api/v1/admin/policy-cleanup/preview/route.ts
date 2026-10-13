import {
  forwardCollaborationMutation,
  invalidCollaborationRoute
} from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const values = [...url.searchParams.entries()];
  if (
    values.length !== 1 ||
    values[0]?.[0] !== "batchLimit" ||
    !/^(?:[1-9]|[1-9]\d|100)$/u.test(values[0][1])
  ) {
    return invalidCollaborationRoute(request, url.pathname);
  }
  return forwardCollaborationMutation(request, {
    method: "GET",
    path: `/api/v1/admin/policy-cleanup/preview?batchLimit=${values[0][1]}`,
    requireCsrf: false,
    withBody: false
  });
}
