import { registryAction } from "../registry-action.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: { params: Promise<{ registryId: string }> }) {
  return registryAction(request, params, "disable", false);
}
