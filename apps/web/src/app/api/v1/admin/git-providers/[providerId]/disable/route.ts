import { action } from "../provider-action.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: { params: Promise<{ providerId: string }> }) { return action(request, params, "disable"); }
