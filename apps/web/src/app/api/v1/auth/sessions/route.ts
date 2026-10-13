import { forwardCreateSession } from "../../../../../lib/api/auth-bff.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return forwardCreateSession(request);
}
