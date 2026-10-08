import { forwardCollaborationMutation, invalidCollaborationRoute, uuidPathSegment } from "../../../../../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

const TYPE = /^(?:oidc|smtp|git_provider|registry)$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export async function POST(request: Request, { params }: { params: Promise<{ integrationType: string; integrationId: string; candidateId: string }> }) {
  const value = await params;
  const candidateId = uuidPathSegment(value.candidateId);
  if (!TYPE.test(value.integrationType) || !ID.test(value.integrationId) || !candidateId) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: `/api/v1/admin/integrations/${value.integrationType}/${value.integrationId}/ca/candidates/${candidateId}/activate`,
    requireCsrf: true,
    withBody: false,
    withEtag: true,
    etagKind: "integration-ca",
    withIdempotencyKey: true,
    commitOutcomeUnknown: true
  });
}
