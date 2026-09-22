import { ServiceBackendError } from "./errors.ts";
import type { IdentityPrincipal, UsageEvent } from "./production-types.ts";
import type { ProductionServiceBackend } from "./production-service.ts";
import type { ProjectSnapshotFile, ShareAccessMode } from "./types.ts";

export interface ProductionApiRequest {
  method: string;
  path: string;
  authorization?: string;
  body?: unknown;
}

export interface ProductionApiResponse {
  status: number;
  body: unknown;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ServiceBackendError("JSON object required", "EINVALID");
  return value as Record<string, unknown>;
}

function bearer(value?: string): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

/** Framework-neutral JSON API used by the preview app and deploy adapters. */
export async function handleProductionApi(
  backend: ProductionServiceBackend,
  request: ProductionApiRequest
): Promise<ProductionApiResponse> {
  try {
    const url = new URL(request.path, "https://service.invalid");
    if (request.method === "GET" && url.pathname === "/api/projects") {
      const actor = await auth(backend, request);
      return ok(await backend.listProjects(actor));
    }
    if (request.method === "POST" && url.pathname === "/api/projects") {
      const actor = await auth(backend, request);
      const body = record(request.body);
      return { status: 201, body: await backend.createProject(actor, String(body.name ?? "")) };
    }
    const resume = url.pathname.match(/^\/api\/projects\/([^/]+)\/resume$/);
    if (request.method === "GET" && resume) {
      return ok(await backend.resumeProject(await auth(backend, request), decodeURIComponent(resume[1]!)));
    }
    const snapshot = url.pathname.match(/^\/api\/projects\/([^/]+)\/snapshot$/);
    if (request.method === "PUT" && snapshot) {
      const body = record(request.body);
      return ok(await backend.saveProject(
        await auth(backend, request),
        decodeURIComponent(snapshot[1]!),
        Array.isArray(body.files) ? body.files as ProjectSnapshotFile[] : []
      ));
    }
    const shares = url.pathname.match(/^\/api\/projects\/([^/]+)\/shares$/);
    if (request.method === "POST" && shares) {
      const body = record(request.body);
      return { status: 201, body: await backend.createShare(
        await auth(backend, request),
        decodeURIComponent(shares[1]!),
        String(body.accessMode) as ShareAccessMode
      ) };
    }
    if (request.method === "GET" && url.pathname === "/api/shares/open") {
      return ok(await backend.openShare(url.searchParams.get("token") ?? ""));
    }
    if (request.method === "POST" && url.pathname === "/api/shares/fork") {
      const body = record(request.body);
      return { status: 201, body: await backend.forkShare(
        await auth(backend, request),
        String(body.token ?? ""),
        typeof body.name === "string" ? body.name : undefined
      ) };
    }
    const rotate = url.pathname.match(/^\/api\/shares\/([^/]+)\/rotate$/);
    if (request.method === "POST" && rotate) {
      return ok(await backend.rotateShare(await auth(backend, request), decodeURIComponent(rotate[1]!)));
    }
    const revoke = url.pathname.match(/^\/api\/shares\/([^/]+)\/revoke$/);
    if (request.method === "POST" && revoke) {
      return ok(await backend.revokeShare(await auth(backend, request), decodeURIComponent(revoke[1]!)));
    }
    if (request.method === "POST" && url.pathname === "/api/usage") {
      const body = record(request.body);
      return { status: 202, body: { inserted: await backend.ingestUsage(
        await auth(backend, request),
        body as unknown as Omit<UsageEvent, "tenantId" | "actorId">
      ) } };
    }
    if (request.method === "GET" && url.pathname === "/api/audit") {
      const actor = await auth(backend, request);
      return ok(await backend.listAudit(actor, url.searchParams.get("resourceId") ?? undefined));
    }
    return { status: 404, body: { error: "not_found" } };
  } catch (error) {
    if (error instanceof ServiceBackendError) {
      const status = error.code === "EAUTH" ? 401 : error.code === "EFORBIDDEN" ? 403 : error.code === "ENOTFOUND" ? 404 : error.code === "ECONFLICT" ? 409 : error.code === "EREVOKED" ? 410 : 400;
      return { status, body: { error: error.code, message: error.message } };
    }
    throw error;
  }
}

async function auth(backend: ProductionServiceBackend, request: ProductionApiRequest): Promise<IdentityPrincipal> {
  return backend.authenticate(bearer(request.authorization));
}

function ok(body: unknown): ProductionApiResponse { return { status: 200, body }; }
