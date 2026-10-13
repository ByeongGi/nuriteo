import { ApiError, getPublicPublishedExampleVersion } from "@nuriteo/api-client";
import { NextResponse } from "next/server.js";

import { createPublicServerApiClient } from "../../../../lib/api/public-server-client.ts";
import {
  publicIdPathSegment,
  publicVersionPathSegment
} from "../../../../lib/published-example-path.ts";
import { previewOriginConfiguration, previewSigningKey } from "../../../../lib/preview/config.ts";
import { publicPreviewClientIdentity } from "../../../../lib/preview/public-client-identity.ts";
import {
  issueSignedPreviewBinding,
  validPreviewSigningKey
} from "../../../../lib/preview/signed-binding.ts";

const MAX_BODY_BYTES = 256;
const DEADLINE_MS = 5_000;
const PREVIEW_ABUSE_KEY_HEADER = "x-nuriteo-preview-abuse-key";
const PREVIEW_ABUSE_PROOF_HEADER = "x-nuriteo-preview-abuse-proof";

export async function POST(request: Request): Promise<NextResponse> {
  const configuration = previewOriginConfiguration();
  const signingKey = previewSigningKey();
  if (configuration.status === "disabled" || !validPreviewSigningKey(signingKey)) {
    cancel(request.body);
    return problem(503, "PUBLIC_PREVIEW_NOT_CONFIGURED");
  }
  if (
    request.headers.get("origin") !== configuration.applicationOrigin
    || request.headers.get("content-type") !== "application/json"
  ) {
    cancel(request.body);
    return problem(403, "PUBLIC_PREVIEW_BINDING_REJECTED");
  }

  const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(DEADLINE_MS)]);
  const input = await readInput(request, deadline);
  if (input === null) {
    return problem(deadline.aborted ? 504 : 400, "PUBLIC_PREVIEW_BINDING_REJECTED");
  }
  const client = await publicPreviewClientIdentity(
    signingKey,
    readCookieHeaders(request.headers),
    input.publicId,
    input.versionNumber,
    configuration.applicationOrigin.startsWith("https://")
  );

  try {
    await getPublicPublishedExampleVersion(
      createPublicServerApiClient(),
      { publicId: input.publicId, versionNumber: input.versionNumber },
      {
        headers: {
          [PREVIEW_ABUSE_KEY_HEADER]: client.abuseKey,
          [PREVIEW_ABUSE_PROOF_HEADER]: client.abuseProof
        },
        signal: deadline,
        timeoutMs: DEADLINE_MS
      }
    );
    const binding = await issueSignedPreviewBinding(signingKey, input.port);
    const response = NextResponse.json(
      {
        runtimeId: binding.runtimeId,
        ttlMs: Math.max(1, binding.expiresAt - Date.now())
      },
      { headers: { "Cache-Control": "no-store" }, status: 201 }
    );
    if (client.setCookie !== undefined) response.headers.append("Set-Cookie", client.setCookie);
    return response;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return problem(404, "PUBLIC_PREVIEW_NOT_FOUND");
    }
    if (error instanceof ApiError && error.status === 429) {
      return problem(429, "PUBLIC_PREVIEW_BINDING_RATE_LIMITED");
    }
    return problem(deadline.aborted ? 504 : 503, "PUBLIC_PREVIEW_BINDING_UNAVAILABLE");
  }
}

async function readInput(request: Request, signal: AbortSignal): Promise<{
  readonly port: number;
  readonly publicId: string;
  readonly versionNumber: number;
} | null> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES || request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelReader = false;
  try {
    while (true) {
      const result = await readWithAbort(reader, signal);
      if (result === null) {
        cancelReader = true;
        return null;
      }
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        cancelReader = true;
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    cancelReader = true;
    return null;
  } finally {
    if (cancelReader || signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
  if (!isExactRecord(value, ["port", "publicId", "versionNumber"])) return null;
  if (
    typeof value.publicId !== "string"
    || publicIdPathSegment(value.publicId) === undefined
    || typeof value.versionNumber !== "number"
    || publicVersionPathSegment(String(value.versionNumber)) === undefined
    || typeof value.port !== "number"
    || !Number.isInteger(value.port)
    || value.port < 1
    || value.port > 65_535
  ) return null;
  return {
    port: value.port,
    publicId: value.publicId,
    versionNumber: value.versionNumber
  };
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
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

function readCookieHeaders(headers: Headers): string[] {
  const value = headers.get("cookie");
  return value === null ? [] : [value];
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function cancel(stream: ReadableStream<Uint8Array> | null): void {
  void stream?.cancel().catch(() => undefined);
}

function problem(status: number, code: string): NextResponse {
  return NextResponse.json(
    {
      code,
      detail: "Public Preview binding request rejected.",
      status,
      title: "Public Preview unavailable",
      type: "about:blank"
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json"
      },
      status
    }
  );
}
