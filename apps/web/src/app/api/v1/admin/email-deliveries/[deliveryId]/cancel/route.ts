import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ deliveryId: string }> }
) {
  const deliveryId = uuidPathSegment((await params).deliveryId);
  if (deliveryId === undefined) return invalidCollaborationRoute(request);
  return forwardCollaborationMutation(request, {
    method: "POST",
    path: `/api/v1/admin/email-deliveries/${deliveryId}/cancel`,
    requireCsrf: true,
    withBody: false,
    withEtag: true,
    etagKind: "email-delivery",
    withIdempotencyKey: true,
    commitOutcomeUnknown: true
  });
}
