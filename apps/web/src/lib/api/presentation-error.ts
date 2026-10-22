import {
  ApiError,
  ApiInvalidResponseError,
  ApiResponseTooLargeError
} from "@nuriteo/api-client";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export type SignInFailureKind = "invalid-credentials" | "service-unavailable";

export function isExplicitlySignedOut(error: unknown): boolean {
  const status = httpStatusFrom(error);
  return status === 401 || status === 403;
}

export function classifySignInFailure(error: unknown): SignInFailureKind {
  const status = httpStatusFrom(error);
  if (status !== undefined && [400, 401, 403, 422].includes(status)) {
    return "invalid-credentials";
  }
  return "service-unavailable";
}

function httpStatusFrom(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = error.status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

export function safeRequestReference(error: unknown): string | undefined {
  const requestId = requestIdFrom(error);
  return requestId !== undefined && SAFE_REQUEST_ID.test(requestId) ? requestId : undefined;
}

function requestIdFrom(error: unknown): string | undefined {
  if (
    error instanceof ApiError ||
    error instanceof ApiInvalidResponseError ||
    error instanceof ApiResponseTooLargeError
  ) {
    return error.requestId;
  }
  return undefined;
}
