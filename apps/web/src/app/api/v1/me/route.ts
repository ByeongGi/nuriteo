import { forwardCurrentUser } from "../../../../lib/api/auth-bff.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return forwardCurrentUser(request);
}
