import "server-only";

import { safeReturnTo } from "#src/app/sign-in/return-to.ts";

const SECURE_COOKIE = "__Host-nuriteo_oidc_return_to";
const DEVELOPMENT_COOKIE = "nuriteo_dev_oidc_return_to";
const MAX_RETURN_TO_BYTES = 2_048;
const RETURN_TO_TTL_SECONDS = 10 * 60;

export function issueOidcReturnToCookie(request: Request, returnTo: string): string {
  const secure = new URL(request.url).protocol === "https:";
  const name = secure ? SECURE_COOKIE : DEVELOPMENT_COOKIE;
  const value = encodeURIComponent(safeReturnTo(returnTo));
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${RETURN_TO_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function readOidcReturnTo(request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  const name = secure ? SECURE_COOKIE : DEVELOPMENT_COOKIE;
  const prefix = `${name}=`;
  const encoded = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
  if (encoded === undefined || encoded.length > MAX_RETURN_TO_BYTES) return safeReturnTo(undefined);
  try {
    return safeReturnTo(decodeURIComponent(encoded));
  } catch {
    return safeReturnTo(undefined);
  }
}

export function clearOidcReturnToCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  const name = secure ? SECURE_COOKIE : DEVELOPMENT_COOKIE;
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function copyResponse(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}
