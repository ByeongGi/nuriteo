const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/u;
const PREVIEW_LABEL = /^r-([a-z2-7]{45})-p([1-9][0-9]{0,4})$/u;
const INTERNAL_PREVIEW_PATH = /^\/__preview\/([^/]+)\/([1-9][0-9]{0,4})\/$/u;

export interface EnabledPreviewOriginConfiguration {
  readonly status: "enabled";
  readonly applicationOrigin: string;
  readonly baseDomain: string;
  readonly protocol: "http:" | "https:";
  readonly publicPort: string;
}

export interface DisabledPreviewOriginConfiguration {
  readonly status: "disabled";
  readonly code: "PREVIEW_CONFIGURATION_INVALID" | "PREVIEW_WILDCARD_NOT_READY";
  readonly message: string;
}

export type PreviewOriginConfiguration = EnabledPreviewOriginConfiguration | DisabledPreviewOriginConfiguration;

export interface PreviewHostBinding {
  readonly hostname: string;
  readonly label: string;
  readonly port: number;
  readonly runtimeId: string;
}

export function resolvePreviewOriginConfiguration(
  environment: Readonly<Record<string, string | undefined>>
): PreviewOriginConfiguration {
  const externalUrl = parseExternalUrl(environment.NURITEO_EXTERNAL_URL);
  const baseDomain = normalizeBaseDomain(environment.NURITEO_PREVIEW_BASE_DOMAIN);
  if (!externalUrl || !baseDomain) return disabled("PREVIEW_CONFIGURATION_INVALID", "Preview origin configuration is invalid.");

  const loopback = isLoopbackHostname(externalUrl.hostname) && baseDomain.endsWith(".localhost");
  if (!loopback && (externalUrl.protocol !== "https:" || environment.NURITEO_PREVIEW_WILDCARD_READY !== "true")) {
    return disabled("PREVIEW_WILDCARD_NOT_READY", "Preview wildcard DNS and TLS are not ready.");
  }
  if (loopback && externalUrl.protocol !== "http:" && externalUrl.protocol !== "https:") {
    return disabled("PREVIEW_CONFIGURATION_INVALID", "Preview origin configuration is invalid.");
  }
  return {
    status: "enabled",
    applicationOrigin: externalUrl.origin,
    baseDomain,
    protocol: externalUrl.protocol as "http:" | "https:",
    publicPort: externalUrl.port
  };
}

export function parsePreviewHost(hostname: string, baseDomain: string): PreviewHostBinding | null {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, "");
  const suffix = `.${baseDomain}`;
  if (!normalizedHostname.endsWith(suffix)) return null;
  const label = normalizedHostname.slice(0, -suffix.length);
  if (label.includes(".")) return null;
  const match = PREVIEW_LABEL.exec(label);
  if (!match) return null;
  const runtimeId = match[1];
  const port = Number(match[2]);
  if (!runtimeId || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { hostname: normalizedHostname, label, port, runtimeId };
}

export function createPreviewOriginUrl(
  configuration: EnabledPreviewOriginConfiguration,
  runtimeId: string,
  port: number
): { binding: PreviewHostBinding; url: string } {
  if (!/^[a-z2-7]{45}$/u.test(runtimeId) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid Preview runtime binding");
  }
  const label = `r-${runtimeId}-p${port}`;
  const hostname = `${label}.${configuration.baseDomain}`;
  const publicPort = configuration.publicPort ? `:${configuration.publicPort}` : "";
  return {
    binding: { hostname, label, port, runtimeId },
    url: `${configuration.protocol}//${hostname}${publicPort}/runtime-preview/bootstrap`
  };
}

export interface InternalPreviewBinding {
  readonly baseUrl: string;
  readonly port: number;
  readonly projectId: string;
}

export function parseInternalPreviewUrl(
  value: string,
  expectedProjectId: string,
  expectedApplicationOrigin: string
): InternalPreviewBinding {
  const url = new URL(value);
  const applicationOrigin = new URL(expectedApplicationOrigin);
  const match = INTERNAL_PREVIEW_PATH.exec(url.pathname);
  const encodedProjectId = match?.[1];
  const port = Number(match?.[2]);
  let projectId: string | undefined;
  try { projectId = encodedProjectId === undefined ? undefined : decodeURIComponent(encodedProjectId); } catch { projectId = undefined; }
  if (!match
      || !projectId
      || projectId !== expectedProjectId
      || encodedProjectId !== encodeURIComponent(expectedProjectId)
      || url.origin !== applicationOrigin.origin
      || url.username
      || url.password
      || url.search
      || url.hash
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535) {
    throw new Error("invalid internal Preview URL");
  }
  return { baseUrl: url.href, port, projectId };
}

function parseExternalUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

function normalizeBaseDomain(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/\.$/u, "");
  return normalized.length <= 198 && DNS_NAME.test(normalized) ? normalized : null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

function disabled(code: DisabledPreviewOriginConfiguration["code"], message: string): DisabledPreviewOriginConfiguration {
  return { status: "disabled", code, message };
}
