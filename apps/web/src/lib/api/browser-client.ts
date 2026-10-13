"use client";

import { createApiClient } from "@nuriteo/api-client";
import type { ApiClient, ApiClientOptions } from "@nuriteo/api-client";

type BrowserApiClientOptions = Pick<
  ApiClientOptions,
  "fetch" | "maxResponseBytes" | "timeoutMs"
>;

export function createBrowserApiClient(options: BrowserApiClientOptions = {}): ApiClient {
  return createApiClient({
    ...options,
    baseUrl: "",
    credentials: "same-origin",
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis)
  });
}
