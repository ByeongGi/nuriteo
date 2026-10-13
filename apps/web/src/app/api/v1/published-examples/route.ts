import { publicExampleListResponse } from "../../../../lib/api/published-example-bff.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return publicExampleListResponse(request);
}
