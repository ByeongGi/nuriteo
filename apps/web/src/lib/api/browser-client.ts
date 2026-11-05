"use client";

import { createApiClient } from "@nuriteo/api-client";
import type { ApiClient, ApiClientOptions } from "@nuriteo/api-client";

import { reauthenticationHref } from "@/app/(public)/sign-in/_utils/return-to.ts";

type BrowserApiClientOptions = Pick<
  ApiClientOptions,
  "fetch" | "maxResponseBytes" | "timeoutMs"
>;

const MAX_PROBLEM_BYTES = 64 * 1024;
let reauthenticationRedirectStarted = false;

export function createBrowserApiClient(options: BrowserApiClientOptions = {}): ApiClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  return createApiClient({
    ...options,
    baseUrl: "",
    credentials: "same-origin",
    fetch: (input, init) => fetchWithReauthenticationRedirect(fetchImplementation, input, init)
  });
}

async function fetchWithReauthenticationRedirect(
  fetchImplementation: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetchImplementation(input, init);
  if (response.status === 403 && isProblemJson(response.headers.get("content-type"))) {
    await redirectWhenReauthenticationIsRequired(response);
  }
  return response;
}

async function redirectWhenReauthenticationIsRequired(response: Response): Promise<void> {
  if (reauthenticationRedirectStarted || typeof window === "undefined") return;
  try {
    const body = await response.clone().text();
    if (body.length > MAX_PROBLEM_BYTES) return;
    const problem: unknown = JSON.parse(body);
    if (!isReauthenticationProblem(problem)) return;
    reauthenticationRedirectStarted = true;
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(reauthenticationHref(returnTo));
  } catch {
    // The API client remains responsible for presenting malformed responses.
  }
}

function isProblemJson(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/problem+json";
}

function isReauthenticationProblem(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && "code" in value && value.code === "REAUTHENTICATION_REQUIRED";
}
