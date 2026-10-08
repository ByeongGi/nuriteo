import { API_PREFIX, createApiClient } from "@nuriteo/api-client";
import type { ApiClient } from "@nuriteo/api-client";

import { DEFAULT_SERVER_API_TIMEOUT_MS, validateInternalApiUrl } from "./server-policy.ts";

const PUBLIC_RESPONSE_MAX_BYTES = 131_072;
const PREVIEW_ABUSE_KEY_HEADER = "x-nuriteo-preview-abuse-key";
const PREVIEW_ABUSE_PROOF_HEADER = "x-nuriteo-preview-abuse-proof";

export interface PublicApiClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly internalApiUrl: string | undefined;
  readonly timeoutMs?: number;
}

export function createPublicApiClient(options: PublicApiClientOptions): ApiClient {
  return createApiClient({
    baseUrl: validateInternalApiUrl(options.internalApiUrl),
    credentials: "omit",
    fetch: publicFetch(options.fetch ?? globalThis.fetch),
    maxResponseBytes: PUBLIC_RESPONSE_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_SERVER_API_TIMEOUT_MS
  });
}

export async function fetchPublicBinary(
  options: PublicApiClientOptions,
  path: `/${string}`
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SERVER_API_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await (options.fetch ?? globalThis.fetch)(
      `${validateInternalApiUrl(options.internalApiUrl)}${API_PREFIX}${path}`,
      {
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/vnd.nuriteo.published-project-bundle" },
        redirect: "error",
        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

function publicFetch(fetchImplementation: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const requestedHeaders = new Headers(init?.headers);
    const headers = new Headers();
    const accept = requestedHeaders.get("accept");
    if (accept !== null) headers.set("accept", accept);
    const previewAbuseKey = requestedHeaders.get(PREVIEW_ABUSE_KEY_HEADER);
    if (previewAbuseKey !== null) headers.set(PREVIEW_ABUSE_KEY_HEADER, previewAbuseKey);
    const previewAbuseProof = requestedHeaders.get(PREVIEW_ABUSE_PROOF_HEADER);
    if (previewAbuseProof !== null) headers.set(PREVIEW_ABUSE_PROOF_HEADER, previewAbuseProof);

    return fetchImplementation(input, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      headers,
      redirect: "error"
    });
  };
}
