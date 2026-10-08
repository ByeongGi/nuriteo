import {
  forwardCollaborationMutation,
  invalidCollaborationRoute
} from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

const SETTING_KEY = /^[a-z][a-z0-9_.-]{0,127}$/u;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  if (!SETTING_KEY.test(key)) return invalidCollaborationRoute(request, requestPath(request));
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: `/api/v1/admin/settings/${key}/impact`,
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 2_048
  });
}

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/api/v1/admin/settings/impact";
  }
}
