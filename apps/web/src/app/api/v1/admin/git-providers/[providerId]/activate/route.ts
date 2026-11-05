import { action } from "@/app/api/v1/admin/git-providers/[providerId]/_utils/provider-action.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: { params: Promise<{ providerId: string }> }) { return action(request, params, "activate"); }
