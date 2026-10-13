import { forwardSaveSessionRequest } from "../../../../../../../../../../../lib/api/save-bff.ts";

interface Context { readonly params: Promise<{ ownerId: string; ownerType: string; projectId: string; sessionId: string }> }

export async function POST(request: Request, { params }: Context): Promise<Response> {
  return forwardSaveSessionRequest(request, await params, "complete");
}
