import "server-only";

import type { ApiClient } from "@nuriteo/api-client";

import { createPublicApiClient } from "./public-server-policy.ts";

const INTERNAL_API_URL_ENV = "NURITEO_INTERNAL_API_URL";

export function createPublicServerApiClient(): ApiClient {
  return createPublicApiClient({
    internalApiUrl: process.env[INTERNAL_API_URL_ENV]
  });
}
