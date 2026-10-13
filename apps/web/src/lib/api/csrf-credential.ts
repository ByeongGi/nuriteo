const CANONICAL_CSRF_CREDENTIAL = /^nrt_csrf_[A-Za-z0-9_-]{43}$/u;

export function isCanonicalCsrfCredential(value: string | null): value is string {
  return value !== null && CANONICAL_CSRF_CREDENTIAL.test(value);
}
