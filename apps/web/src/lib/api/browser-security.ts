"use client";

import { ApiError } from "@nuriteo/api-client";

const CSRF_NAMES = ["__Host-nuriteo_csrf", "nuriteo_dev_csrf"] as const;
const SAFE_CREDENTIAL = /^nrt_csrf_[A-Za-z0-9_-]{43}$/u;

export function readCsrfCredential(): string {
  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    if (!CSRF_NAMES.includes(name as (typeof CSRF_NAMES)[number])) continue;
    const value = pair.slice(separator + 1);
    if (SAFE_CREDENTIAL.test(value)) return value;
  }
  throw new Error("Browser security credential is unavailable.");
}

export function collaborationError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "You do not have permission for this action.";
    if (error.status === 412 || error.status === 428) {
      return "This Organization changed. Reload the latest version before trying again.";
    }
    if (error.status === 409 || error.status === 410 || error.status === 422) {
      return "This invitation is no longer usable. It may be expired, used, revoked, or replaced.";
    }
  }
  return "The request could not be completed. Check the service and try again.";
}
