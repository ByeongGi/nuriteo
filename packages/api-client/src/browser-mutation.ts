import { ApiConfigurationError } from "./errors.ts";
import type { DomainRequestOptions } from "./domain.ts";

const MAX_CSRF_BYTES = 512;

export interface BrowserMutationOptions extends DomainRequestOptions {
  readonly csrfToken: string;
}

export function mutationOptions(
  { csrfToken, ...options }: BrowserMutationOptions,
  extraHeaders?: HeadersInit
): DomainRequestOptions & { readonly headers: Headers } {
  validateHeaderValue(csrfToken, "CSRF credential");
  const headers = new Headers(extraHeaders);
  headers.set("x-csrf-token", csrfToken);
  return { ...options, headers };
}

export function validateHeaderValue(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_CSRF_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ApiConfigurationError(`The ${label} is invalid.`);
  }
}
