import "server-only";

import { headers } from "next/headers";
import type { ApiClient } from "@nuriteo/api-client";

import { createRequestScopedApiClient } from "./server-policy.ts";

const INTERNAL_API_URL_ENV = "NURITEO_INTERNAL_API_URL";

export async function createServerApiClient(): Promise<ApiClient> {
  const incomingHeaders = await headers();

  return createRequestScopedApiClient({
    incomingHeaders,
    internalApiUrl: process.env[INTERNAL_API_URL_ENV]
  });
}
