import { forwardCollaborationMutation, invalidCollaborationRoute } from "../../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

const TYPE = /^(?:oidc|smtp|git_provider|registry)$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export async function GET(request: Request, { params }: { params: Promise<{ integrationType: string; integrationId: string }> }) {
  const value = await params;
  if (!TYPE.test(value.integrationType) || !ID.test(value.integrationId)) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "GET",
    path: `/api/v1/admin/integrations/${value.integrationType}/${value.integrationId}/ca`,
    requireCsrf: false,
    withBody: false
  });
}
