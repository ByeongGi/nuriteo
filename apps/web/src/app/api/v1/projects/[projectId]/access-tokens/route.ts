import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../../../../../../lib/api/collaboration-bff.ts";

export const dynamic = "force-dynamic";

async function path(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const projectId = uuidPathSegment((await context.params).projectId);
  if (projectId === undefined) return { error: invalidCollaborationRoute(request) } as const;
  return { value: `/api/v1/projects/${projectId}/access-tokens` as const } as const;
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const resolved = await path(request, context);
  if ("error" in resolved) return resolved.error;
  return forwardCollaborationMutation(request, {
    method: "GET", path: resolved.value, requireCsrf: false, withBody: false
  });
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const resolved = await path(request, context);
  if ("error" in resolved) return resolved.error;
  return forwardCollaborationMutation(request, {
    commitOutcomeUnknown: true,
    method: "POST",
    path: resolved.value,
    requireCsrf: true,
    withBody: true,
    maxBodyBytes: 4_096
  });
}
