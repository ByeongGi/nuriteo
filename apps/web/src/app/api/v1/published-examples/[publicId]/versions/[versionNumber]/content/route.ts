import { publicExampleContentResponse } from "../../../../../../../../lib/api/published-example-bff.ts";

interface Context {
  readonly params: Promise<{
    readonly publicId: string;
    readonly versionNumber: string;
  }>;
}

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  const { publicId, versionNumber } = await context.params;
  return publicExampleContentResponse(request, publicId, versionNumber);
}
