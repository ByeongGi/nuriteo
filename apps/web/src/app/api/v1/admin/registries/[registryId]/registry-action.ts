import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../lib/api/collaboration-bff.ts";

export async function registryAction(
  request: Request,
  params: Promise<{ registryId: string }>,
  action: "activate" | "default" | "disable" | "rotate-token",
  withBody: boolean
) {
  const registryId = uuidPathSegment((await params).registryId);
  if (registryId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: `/api/v1/admin/registries/${registryId}/${action}`,
    requireCsrf: true,
    withBody,
    withEtag: true,
    etagKind: "registry",
    maxBodyBytes: 4_096,
    commitOutcomeUnknown: true
  });
}
