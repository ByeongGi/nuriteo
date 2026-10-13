export interface FetchPolicyOptions {
  allowedHosts?: Iterable<string>;
  allowedSchemes?: Iterable<string>;
  maxRedirects?: number;
  maxBytes?: number;
}

export type HostFetchErrorCode =
  | "EBADREDIRECT"
  | "EBADINTEGRITY"
  | "EINTEGRITY"
  | "ETOOBIG"
  | "ETOOMANYREDIRECTS"
  | "FETCH_ABORTED"
  | "FETCH_ERROR"
  | "FETCH_TIMEOUT"
  | (string & {});

export interface HostFetchErrorOptions {
  code?: HostFetchErrorCode;
  url?: string | null;
  status?: number | null;
}

export interface HostFetchOptions extends RequestInit {
  integrity?: string;
  maxBytes?: number;
  maxRedirects?: number;
  projectId?: string;
  timeoutMs?: number;
  timeoutSignal?: AbortSignal;
  externalSignal?: AbortSignal;
}

export interface HostDownloadRedirect {
  from: string;
  to: string;
  status: number;
}

export interface HostDownloadResult {
  url: string;
  status: number;
  ok: boolean;
  redirected: boolean;
  redirects: HostDownloadRedirect[];
  headers: Record<string, string>;
  body: Uint8Array;
  sha256: string;
}

export interface HostFetcherOptions {
  fetchImpl?: typeof fetch;
  policy?: import("./fetch-policy.ts").FetchPolicy;
  policyOptions?: FetchPolicyOptions;
  permissions?: import("../security/index.ts").PermissionManager;
  trace?: import("../observability/index.ts").RuntimeTraceSink;
}
