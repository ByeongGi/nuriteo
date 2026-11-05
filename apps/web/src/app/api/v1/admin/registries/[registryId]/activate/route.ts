import { registryAction } from "@/app/api/v1/admin/registries/[registryId]/_utils/registry-action.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: { params: Promise<{ registryId: string }> }) {
  return registryAction(request, params, "activate", false);
}
