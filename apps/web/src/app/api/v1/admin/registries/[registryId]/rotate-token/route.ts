import { registryAction } from "#src/app/api/v1/admin/registries/[registryId]/registry-action.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: { params: Promise<{ registryId: string }> }) {
  return registryAction(request, params, "rotate-token", true);
}
