import { forwardDeleteSession } from "#src/lib/api/auth-bff.ts";

export const dynamic = "force-dynamic";

export function DELETE(request: Request): Promise<Response> {
  return forwardDeleteSession(request);
}
