import { resolve as resolvePath } from "./path.ts";

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export const domainToASCII = (domain: string): string => domain;
export const domainToUnicode = (domain: string): string => domain;

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

export const urlBuiltin = Object.freeze({
  URL,
  URLSearchParams,
  default: {
    URL,
    URLSearchParams,
    domainToASCII,
    domainToUnicode,
    fileURLToPath,
    pathToFileURL,
    urlToHttpOptions
  },
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  pathToFileURL,
  urlToHttpOptions
});
