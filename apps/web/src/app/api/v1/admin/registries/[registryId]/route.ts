import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

async function registry(
  request: Request,
  params: Promise<{ registryId: string }>,
  method: "DELETE" | "PATCH"
) {
  const registryId = uuidPathSegment((await params).registryId);
  if (registryId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method,
    path: `/api/v1/admin/registries/${registryId}`,
    requireCsrf: true,
    withBody: method === "PATCH",
    withEtag: true,
    etagKind: "registry",
    maxBodyBytes: 4_096,
    commitOutcomeUnknown: true
  });
}

export function PATCH(request: Request, { params }: { params: Promise<{ registryId: string }> }) {
  return registry(request, params, "PATCH");
}

export function DELETE(request: Request, { params }: { params: Promise<{ registryId: string }> }) {
  return registry(request, params, "DELETE");
}
