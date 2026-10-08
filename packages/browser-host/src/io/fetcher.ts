import crypto from "node:crypto";

import { FetchPolicy, FetchPolicyError } from "./fetch-policy.ts";
import type { HostDownloadResult, HostFetchErrorCode, HostFetchErrorOptions, HostFetcherOptions, HostFetchOptions } from "./types.ts";
import type { RuntimeTraceSink } from "../observability/index.ts";
import type { PermissionManager } from "../security/index.ts";
import { stripSensitiveHeadersForRedirect } from "../security/index.ts";

export class HostFetchError extends Error {
  code: HostFetchErrorCode;
  url: string | null;
  status: number | null;

  constructor(message: string, options: HostFetchErrorOptions = {}) {
    super(message);
    this.name = "HostFetchError";
    this.code = options.code || "FETCH_ERROR";
    this.url = options.url || null;
    this.status = options.status || null;
  }
}

export class HostFetcher {
  fetchImpl: typeof fetch;
  policy: FetchPolicy;
  permissions: PermissionManager | null;
  trace: RuntimeTraceSink | null;

  constructor(options: HostFetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.policy = options.policy || new FetchPolicy(options.policyOptions);
    this.permissions = options.permissions || null;
    this.trace = options.trace || null;
  }

  async download(input: string | URL, options: HostFetchOptions = {}): Promise<HostDownloadResult> {
    let url = this.policy.assertAllowed(input);
    const span = this.trace?.startSpan({
      category: "network",
      name: "host-fetch.download",
      ...(options.projectId ? { requestId: options.projectId } : {}),
      attributes: { url: url.href }
    });
    const redirects: HostDownloadResult["redirects"] = [];
    const maxRedirects = options.maxRedirects ?? this.policy.maxRedirects;
    let headers = options.headers || {};
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new Error("fetch timeout")), options.timeoutMs ?? 30000);
    const signals = [timeoutController.signal, options.signal].filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    const requestOptions: HostFetchOptions = { ...options, signal, timeoutSignal: timeoutController.signal };
    if (options.signal) requestOptions.externalSignal = options.signal;

    try {
      this.permissions?.assertAllowed({
        scope: "network",
        action: "fetch",
        resource: url.href,
        ...(options.projectId ? { projectId: options.projectId } : {})
      });
      for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
        const response = await this.#fetch(url, { ...requestOptions, headers });
        if (!isRedirect(response.status)) {
          const body = await this.#readBody(response, requestOptions);
          const sha256 = digest("sha256", body, "hex");
          verifyIntegrity(body, options.integrity);
          const result = {
            url: url.href,
            status: response.status,
            ok: response.ok,
            redirected: redirects.length > 0,
            redirects,
            headers: Object.fromEntries(response.headers.entries()),
            body,
            sha256
          };
          span?.end({ status: response.ok ? "ok" : "error", attributes: { status: response.status, bytes: body.byteLength } });
          return result;
        }

        const location = response.headers.get("location");
        if (!location) throw new HostFetchError("redirect without location", { code: "EBADREDIRECT", url: url.href, status: response.status });
        const next = this.policy.assertAllowed(new URL(location, url).href);
        this.permissions?.assertAllowed({
          scope: "network",
          action: "redirect",
          resource: next.href,
          ...(options.projectId ? { projectId: options.projectId } : {})
        });
        redirects.push({ from: url.href, to: next.href, status: response.status });
        headers = stripSensitiveHeadersForRedirect(headers, url, next);
        url = next;
      }

      const error = new HostFetchError("too many redirects", { code: "ETOOMANYREDIRECTS", url: url.href });
      span?.end({ status: "error", errorCode: error.code });
      throw error;
    } catch (error) {
      span?.end({ status: "error", errorCode: errorCode(error) });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #fetch(url: URL, options: HostFetchOptions): Promise<Response> {
    try {
      const init: RequestInit = {
        credentials: "omit",
        method: options.method || "GET",
        headers: options.headers || {},
        redirect: "manual",
        referrerPolicy: "no-referrer"
      };
      if (options.signal !== undefined) init.signal = options.signal;
      if (options.body !== undefined) init.body = options.body;
      return await this.fetchImpl(url.href, init);
    } catch (error) {
      if (options.timeoutSignal?.aborted) {
        throw new HostFetchError(`fetch timeout: ${url.href}`, { code: "FETCH_TIMEOUT", url: url.href });
      }
      if (options.externalSignal?.aborted) {
        throw new HostFetchError(`fetch aborted: ${url.href}`, { code: "FETCH_ABORTED", url: url.href });
      }
      throw error;
    }
  }

  async #readBody(response: Response, options: HostFetchOptions): Promise<Uint8Array> {
    const maxBytes = options.maxBytes ?? this.policy.maxBytes;
    const bytes = [];
    let total = 0;

    try {
      for await (const chunk of response.body || []) {
        const current = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
        total += current.byteLength;
        if (total > maxBytes) {
          throw new HostFetchError(`response exceeded ${maxBytes} bytes`, { code: "ETOOBIG", url: response.url, status: response.status });
        }
        bytes.push(current);
      }
    } catch (error) {
      if (options.timeoutSignal?.aborted) {
        throw new HostFetchError(`fetch timeout: ${response.url}`, { code: "FETCH_TIMEOUT", url: response.url, status: response.status });
      }
      if (options.externalSignal?.aborted) {
        throw new HostFetchError(`fetch aborted: ${response.url}`, { code: "FETCH_ABORTED", url: response.url, status: response.status });
      }
      throw error;
    }

    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of bytes) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

export function verifyIntegrity(body: Uint8Array, integrity?: string): boolean {
  if (!integrity) return true;
  const [algorithm, expected] = integrity.split("-", 2);
  if (!algorithm || !expected) throw new HostFetchError(`unsupported integrity: ${integrity}`, { code: "EBADINTEGRITY" });
  const actual = digest(algorithm, body, expected.length === 64 ? "hex" : "base64");
  if (actual !== expected) {
    throw new HostFetchError(`integrity mismatch for ${algorithm}`, { code: "EINTEGRITY" });
  }
  return true;
}

function digest(algorithm: string, body: Uint8Array, encoding: "hex" | "base64"): string {
  return crypto.createHash(algorithm).update(body).digest(encoding);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EUNKNOWN";
}

export { FetchPolicy, FetchPolicyError };
export type { FetchPolicyOptions, HostDownloadRedirect, HostDownloadResult, HostFetchErrorCode, HostFetchErrorOptions, HostFetcherOptions, HostFetchOptions } from "./types.ts";
