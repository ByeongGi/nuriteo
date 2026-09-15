import { resolve as resolvePath } from "./path.ts";
import { parse as parseQueryString, stringify as stringifyQueryString } from "./querystring.ts";

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export const domainToASCII = (domain: string): string => domain;
export const domainToUnicode = (domain: string): string => domain;

export interface UrlParseResult {
  auth: string | null;
  hash: string | null;
  host: string | null;
  hostname: string | null;
  href: string;
  path: string | null;
  pathname: string | null;
  port: string | null;
  protocol: string | null;
  query: string | Record<string, string | string[]> | null;
  search: string | null;
  slashes: boolean | null;
}

export function pathToFileURL(path: string): URL {
  const absolute = resolvePath(path);
  return new URL(`file://${encodeURI(absolute).replaceAll("#", "%23").replaceAll("?", "%3F")}`);
}

export function fileURLToPath(value: string | URL): string {
  const url = typeof value === "string" ? new URL(value) : value;
  if (url.protocol !== "file:") throw new TypeError("The URL must use the file protocol");
  return decodeURIComponent(url.pathname);
}

export function urlToHttpOptions(value: string | URL): {
  protocol: string;
  hostname: string;
  hash: string;
  search: string;
  pathname: string;
  path: string;
  href: string;
  port?: number;
  auth?: string;
} {
  const url = typeof value === "string" ? new URL(value) : value;
  const options: ReturnType<typeof urlToHttpOptions> = {
    protocol: url.protocol,
    hostname: url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname}${url.search}`,
    href: url.href
  };
  if (url.port) options.port = Number(url.port);
  if (url.username || url.password) options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return options;
}

export function parse(value: string, parseQueryStringOption = false): UrlParseResult {
  const parsed = new URL(value, "resolve://");
  const isRelative = parsed.protocol === "resolve:";
  const pathname = parsed.pathname === "/" && isRelative && !value.startsWith("/") ? null : decodeURIComponent(parsed.pathname);
  const search = parsed.search || null;
  const query = parseQueryStringOption ? parseQueryString(search ? search.slice(1) : "") : (search ? search.slice(1) : null);
  return {
    auth: parsed.username || parsed.password ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}` : null,
    hash: parsed.hash || null,
    host: isRelative ? null : parsed.host || null,
    hostname: isRelative ? null : parsed.hostname || null,
    href: isRelative ? value : parsed.href,
    path: `${pathname ?? ""}${search ?? ""}` || null,
    pathname,
    port: parsed.port || null,
    protocol: isRelative ? null : parsed.protocol,
    query,
    search,
    slashes: isRelative ? null : value.includes("//")
  };
}

export function format(value: Partial<UrlParseResult> | URL): string {
  if (value instanceof URL) return value.href;
  if (value.href && !value.protocol && !value.host && !value.pathname) return value.href;
  const auth = value.auth ? `${encodeURIComponent(value.auth).replace("%3A", ":")}@` : "";
  const host = value.host ?? [value.hostname, value.port].filter(Boolean).join(":");
  const protocol = value.protocol ?? "";
  const slashes = value.slashes || host ? "//" : "";
  const pathname = value.pathname ?? "";
  const search = value.search ?? (value.query && typeof value.query === "object" ? `?${stringifyQueryString(value.query)}` : value.query ? `?${value.query}` : "");
  const hash = value.hash ?? "";
  return `${protocol}${slashes}${auth}${host}${pathname}${search}${hash}`;
}

export function resolve(from: string, to: string): string {
  if (from.startsWith("//")) {
    return new URL(to, `resolve:${from}`).href.replace(/^resolve:/, "");
  }
  try {
    return new URL(to, from).href;
  } catch (error) {
    if (error instanceof TypeError) return new URL(to, `resolve://${from}`).href.replace(/^resolve:\/\//, "");
    throw error;
  }
}

export const urlBuiltin = Object.freeze({
  URL,
  URLSearchParams,
  default: {
    URL,
    URLSearchParams,
    domainToASCII,
    domainToUnicode,
    fileURLToPath,
    format,
    pathToFileURL,
    parse,
    resolve,
    urlToHttpOptions
  },
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  format,
  pathToFileURL,
  parse,
  resolve,
  urlToHttpOptions
});
