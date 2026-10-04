import { forwardProjectHistoryRequest } from "../../../../../../../../../../lib/api/history-bff.ts";

interface Context { readonly params: Promise<{ ownerId: string; ownerType: string; projectId: string }> }

export async function GET(request: Request, { params }: Context): Promise<Response> {
  return forwardProjectHistoryRequest(request, await params, "restore");
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  return forwardProjectHistoryRequest(request, await params, "restore");
}
