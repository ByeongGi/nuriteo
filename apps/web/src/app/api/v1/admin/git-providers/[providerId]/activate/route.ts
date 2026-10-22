import { action } from "#src/app/api/v1/admin/git-providers/[providerId]/provider-action.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: { params: Promise<{ providerId: string }> }) { return action(request, params, "activate"); }
