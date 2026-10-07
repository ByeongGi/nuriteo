import {
  forwardCollaborationMutation,
  invalidCollaborationRoute
} from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

const SETTING_KEY = /^[a-z][a-z0-9_.-]{0,127}$/u;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  if (!SETTING_KEY.test(key)) return invalidCollaborationRoute(request, requestUrl(request));
  return forwardCollaborationMutation(request, {
    method: "PATCH",
    path: `/api/v1/admin/settings/${key}`,
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 2_048,
    withEtag: true,
    etagKind: "setting"
  });
}

function requestUrl(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/api/v1/admin/settings";
  }
}
