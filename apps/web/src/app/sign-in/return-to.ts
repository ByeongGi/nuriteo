const DEFAULT_SIGN_IN_DESTINATION = "/dashboard";
const RETURN_TO_BASE_URL = "https://nuriteo.invalid";

/**
 * Accept only same-origin application paths. This keeps the post-authentication
 * redirect useful without turning the sign-in page into an open redirect.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (
    value === undefined ||
    value === null ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    return DEFAULT_SIGN_IN_DESTINATION;
  }

  try {
    const destination = new URL(value, RETURN_TO_BASE_URL);
    if (destination.origin !== RETURN_TO_BASE_URL || destination.pathname === "/sign-in") {
      return DEFAULT_SIGN_IN_DESTINATION;
    }
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return DEFAULT_SIGN_IN_DESTINATION;
  }
}

export function signInHref(returnTo: string): string {
  const safeDestination = safeReturnTo(returnTo);
  return `/sign-in?returnTo=${encodeURIComponent(safeDestination)}`;
}

export { DEFAULT_SIGN_IN_DESTINATION };
