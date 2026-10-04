import { forwardSaveUploadRequest } from "../../../../../../../../../../../../../lib/api/save-bff.ts";

interface Context {
  readonly params: Promise<{
    ownerId: string;
    ownerType: string;
    partNumber: string;
    projectId: string;
    sessionId: string;
  }>;
}

export async function PUT(request: Request, { params }: Context): Promise<Response> {
  return forwardSaveUploadRequest(request, await params);
}
