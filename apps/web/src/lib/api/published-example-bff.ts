import "server-only";

import {
  ApiError,
  getPublicPublishedExample,
  getPublicPublishedExampleVersion,
  listPublicPublishedExamples,
  publicPublishedExampleContentPath
} from "@nuriteo/api-client";
import type { PublicPublishedExample } from "@nuriteo/api-client";

import {
  publicIdPathSegment,
  publicVersionPathSegment
} from "../published-example-path.ts";
import { boundedContentStream } from "./content-bff.ts";
import { createPublicServerApiClient } from "./public-server-client.ts";
import { fetchPublicBinary } from "./public-server-policy.ts";

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const CONTENT_ETAG = /^"published-content-v[1-9]\d*-[A-Za-z0-9_-]{43}"$/u;
const MAX_BUNDLE_BYTES = 288 * 1024 * 1024;
const CONTENT_BODY_IDLE_TIMEOUT_MS = 60_000;
const CONTENT_BODY_TOTAL_TIMEOUT_MS = 30 * 60_000;

export async function publicExampleListResponse(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || !validListQuery(url.searchParams)) {
    return publicProblem(400, "PUBLIC_EXAMPLE_REQUEST_REJECTED");
  }
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? undefined : Number(limitValue);

  try {
    const result = await listPublicPublishedExamples(
      createPublicServerApiClient(),
      limit === undefined ? {} : { limit }
    );
    return publicJson(result.data, result.requestId);
  } catch (error) {
    return publicApiFailure(error);
  }
}

export async function publicExampleResponse(
  request: Request,
  publicId: string
): Promise<Response> {
  if (request.method !== "GET" || publicIdPathSegment(publicId) === undefined) {
    return publicProblem(400, "PUBLIC_EXAMPLE_REQUEST_REJECTED");
  }
  try {
    const result = await getPublicPublishedExample(createPublicServerApiClient(), { publicId });
    return publicJson(result.data, result.requestId);
  } catch (error) {
    return publicApiFailure(error);
  }
}

export async function publicExampleVersionResponse(
  request: Request,
  publicId: string,
  rawVersionNumber: string
): Promise<Response> {
  const versionNumber = publicVersionPathSegment(rawVersionNumber);
  if (
    request.method !== "GET" ||
    publicIdPathSegment(publicId) === undefined ||
    versionNumber === undefined
  ) {
    return publicProblem(400, "PUBLIC_EXAMPLE_REQUEST_REJECTED");
  }
  try {
    const result = await getPublicPublishedExampleVersion(createPublicServerApiClient(), {
      publicId,
      versionNumber
    });
    return publicJson(result.data, result.requestId);
  } catch (error) {
    return publicApiFailure(error);
  }
}

export async function publicExampleContentResponse(
  request: Request,
  publicId: string,
  rawVersionNumber?: string
): Promise<Response> {
  const versionNumber = rawVersionNumber === undefined
    ? undefined
    : publicVersionPathSegment(rawVersionNumber);
  if (
    request.method !== "GET" ||
    request.headers.has("range") ||
    publicIdPathSegment(publicId) === undefined ||
    (rawVersionNumber !== undefined && versionNumber === undefined)
  ) {
    return publicProblem(request.headers.has("range") ? 416 : 400, "PUBLIC_CONTENT_REQUEST_REJECTED");
  }
  const path = versionNumber === undefined
    ? publicPublishedExampleContentPath({ publicId })
    : publicPublishedExampleContentPath({ publicId, versionNumber });
  try {
    const upstream = await fetchPublicBinary(
      { internalApiUrl: process.env.NURITEO_INTERNAL_API_URL },
      path
    );
    if (!upstream.ok) {
      return publicProblem(
        upstream.status === 404 ? 404 : upstream.status === 416 ? 416 : 502,
        upstream.status === 404 ? "PUBLIC_CONTENT_NOT_FOUND" : "PUBLIC_CONTENT_UPSTREAM_FAILED"
      );
    }
    const contentType = upstream.headers.get("content-type");
    const contentLength = Number(upstream.headers.get("content-length"));
    const etag = upstream.headers.get("etag");
    if (
      contentType !== "application/vnd.nuriteo.published-project-bundle" ||
      !Number.isSafeInteger(contentLength) ||
      contentLength < 1 ||
      contentLength > MAX_BUNDLE_BYTES ||
      etag === null ||
      !CONTENT_ETAG.test(etag) ||
      upstream.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff" ||
      upstream.headers.get("cross-origin-resource-policy")?.toLowerCase() !== "same-origin" ||
      upstream.body === null
    ) {
      upstream.body?.cancel().catch(() => undefined);
      return publicProblem(502, "PUBLIC_CONTENT_UPSTREAM_FAILED");
    }
    return new Response(
      boundedContentStream(upstream.body, contentLength, request.signal, {
        idleTimeoutMs: CONTENT_BODY_IDLE_TIMEOUT_MS,
        totalTimeout: AbortSignal.timeout(CONTENT_BODY_TOTAL_TIMEOUT_MS)
      }),
      {
        headers: {
          "cache-control": "no-store",
          "content-disposition": "attachment; filename=\"nuriteo-published-example.tar\"",
          "content-length": String(contentLength),
          "content-type": contentType,
          "cross-origin-resource-policy": "same-origin",
          etag,
          "x-content-type-options": "nosniff"
        }
      }
    );
  } catch {
    return publicProblem(502, "PUBLIC_CONTENT_UPSTREAM_FAILED");
  }
}

function validListQuery(parameters: URLSearchParams): boolean {
  if ([...parameters.keys()].some((key) => key !== "limit")) return false;
  if (parameters.getAll("limit").length > 1) return false;
  const limit = parameters.get("limit");
  return limit === null || /^(?:[1-9]|[1-9]\d|100)$/u.test(limit);
}

function publicJson(data: PublicPublishedExample | { readonly items: readonly PublicPublishedExample[] }, requestId?: string): Response {
  const headers = new Headers({
    "cache-control": "public, max-age=0, must-revalidate",
    "content-type": "application/json; charset=utf-8"
  });
  if (requestId !== undefined && REQUEST_ID.test(requestId)) {
    headers.set("x-request-id", requestId);
  }
  return Response.json(data, { headers });
}

function publicApiFailure(error: unknown): Response {
  if (error instanceof ApiError) {
    const status = error.status === 404 ? 404 : error.status === 429 ? 429 : 502;
    return publicProblem(status, status === 404 ? "PUBLIC_EXAMPLE_NOT_FOUND" : "PUBLIC_EXAMPLE_UPSTREAM_FAILED");
  }
  return publicProblem(502, "PUBLIC_EXAMPLE_UPSTREAM_FAILED");
}

function publicProblem(status: number, code: string): Response {
  return Response.json(
    { code, status },
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/problem+json; charset=utf-8"
      },
      status
    }
  );
}
