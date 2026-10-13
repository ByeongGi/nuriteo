import {
  ApiError,
  ApiInvalidResponseError,
  ApiResponseTooLargeError
} from "@nuriteo/api-client";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export type SignInFailureKind = "invalid-credentials" | "service-unavailable";

export function isExplicitlySignedOut(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function classifySignInFailure(error: unknown): SignInFailureKind {
  if (error instanceof ApiError && [400, 401, 403, 422].includes(error.status)) {
    return "invalid-credentials";
  }
  return "service-unavailable";
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
