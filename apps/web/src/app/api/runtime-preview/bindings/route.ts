import { ApiError, getCurrentUser, getProject } from "@nuriteo/api-client";
import { NextResponse } from "next/server.js";

import { createRequestScopedApiClient } from "../../../../lib/api/server-policy.ts";
import { previewOriginConfiguration, previewSigningKey } from "../../../../lib/preview/config.ts";
import { issueSignedPreviewBinding, validPreviewSigningKey } from "../../../../lib/preview/signed-binding.ts";

const MAX_BODY_BYTES = 512;
const DEADLINE_MS = 5_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CSRF_COOKIE = /(?:^|;\s*)(?:__Host-nuriteo_csrf|nuriteo_dev_csrf)=(nrt_csrf_[A-Za-z0-9_-]{43})(?:;|$)/u;
const rateWindows = new Map<string, { count: number; startedAt: number }>();

export async function POST(request: Request): Promise<NextResponse> {
  const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(DEADLINE_MS)]);
  const configuration = previewOriginConfiguration();
  const signingKey = previewSigningKey();
  if (configuration.status === "disabled" || !validPreviewSigningKey(signingKey)) return problem(503, "PREVIEW_NOT_CONFIGURED");
  if (request.headers.get("origin") !== configuration.applicationOrigin || request.headers.get("content-type") !== "application/json") {
    cancel(request.body);
    return problem(403, "PREVIEW_BINDING_REJECTED");
  }
  const csrf = request.headers.get("x-csrf-token");
  const cookieCsrf = CSRF_COOKIE.exec(request.headers.get("cookie") ?? "")?.[1];
  if (!csrf || csrf !== cookieCsrf) {
    cancel(request.body);
    return problem(403, "PREVIEW_BINDING_REJECTED");
  }
  const input = await readInput(request, deadline);
  if (!input) return problem(deadline.aborted ? 504 : 400, "PREVIEW_BINDING_REJECTED");

  try {
    const client = createRequestScopedApiClient({
      incomingHeaders: request.headers,
      internalApiUrl: process.env.NURITEO_INTERNAL_API_URL,
      maxResponseBytes: 64 * 1024,
      timeoutMs: DEADLINE_MS
    });
    const [me] = await Promise.all([
      getCurrentUser(client, { signal: deadline, timeoutMs: DEADLINE_MS }),
      getProject(client, {
        owner: { ownerId: input.ownerId, ownerType: input.ownerType },
        projectId: input.projectId
      }, { signal: deadline, timeoutMs: DEADLINE_MS })
    ]);
    if (!consumeRate(me.data.session.id, Date.now())) return problem(429, "PREVIEW_BINDING_RATE_LIMITED");
    const binding = await issueSignedPreviewBinding(signingKey, input.port);
    return NextResponse.json({ runtimeId: binding.runtimeId, ttlMs: Math.max(1, binding.expiresAt - Date.now()) }, { headers: { "Cache-Control": "no-store" }, status: 201 });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
      return problem(403, "PREVIEW_BINDING_REJECTED");
    }
    return problem(deadline.aborted ? 504 : 503, "PREVIEW_BINDING_UNAVAILABLE");
  }
}

async function readInput(request: Request, signal: AbortSignal): Promise<{
  ownerId: string;
  ownerType: "organization" | "user";
  port: number;
  projectId: string;
} | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let mustCancel = false;
  try {
    for (;;) {
      const result = await readWithAbort(reader, signal);
      if (result === null) {
        mustCancel = true;
        return null;
      }
      const { done, value } = result;
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        mustCancel = true;
        return null;
      }
      chunks.push(value);
    }
  } catch {
    mustCancel = true;
    return null;
  } finally {
    if (mustCancel || signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
  if (!isExactRecord(value, ["ownerId", "ownerType", "port", "projectId"])) return null;
  if ((value.ownerType !== "user" && value.ownerType !== "organization")
      || typeof value.ownerId !== "string"
      || !UUID_V7.test(value.ownerId)
      || typeof value.projectId !== "string"
      || !UUID_V7.test(value.projectId)
      || typeof value.port !== "number"
      || !Number.isInteger(value.port)
      || value.port < 1
      || value.port > 65_535) return null;
  return { ownerId: value.ownerId, ownerType: value.ownerType, port: value.port, projectId: value.projectId };
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  if (signal.aborted) return null;
  let abort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    abort = () => resolve(null);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function consumeRate(sessionId: string, now: number): boolean {
  if (rateWindows.size > 10_000) rateWindows.clear();
  const current = rateWindows.get(sessionId);
  if (!current || now - current.startedAt >= 60_000) {
    rateWindows.set(sessionId, { count: 1, startedAt: now });
    return true;
  }
  if (current.count >= 12) return false;
  current.count += 1;
  return true;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function cancel(stream: ReadableStream<Uint8Array> | null): void {
  void stream?.cancel().catch(() => undefined);
}

function problem(status: number, code: string): NextResponse {
  return NextResponse.json({ code, detail: "Preview binding request rejected.", status, title: "Preview unavailable", type: "about:blank" }, {
    headers: { "Cache-Control": "no-store", "Content-Type": "application/problem+json" },
    status
  });
}
