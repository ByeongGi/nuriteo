import { forwardCollaborationMutation, invalidCollaborationRoute, uuidPathSegment } from "../../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const userId = uuidPathSegment((await params).userId);
  if (userId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, { method: "POST", path: `/api/v1/admin/users/${userId}/mfa/reset`, requireCsrf: true, withBody: true, maxBodyBytes: 2_048 });
}
