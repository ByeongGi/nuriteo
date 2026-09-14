import crypto from "node:crypto";

import { FetchPolicy, FetchPolicyError } from "./fetch-policy.ts";

export class HostFetchError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "HostFetchError";
    this.code = options.code || "FETCH_ERROR";
    this.url = options.url || null;
    this.status = options.status || null;
  }
}

export class HostFetcher {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.policy = options.policy || new FetchPolicy(options.policyOptions);
  }

  async download(input, options = {}) {
    let url = this.policy.assertAllowed(input);
    const redirects = [];
    const maxRedirects = options.maxRedirects ?? this.policy.maxRedirects;
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new Error("fetch timeout")), options.timeoutMs ?? 30000);
    const signals = [timeoutController.signal, options.signal].filter(Boolean);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    const requestOptions = { ...options, signal, timeoutSignal: timeoutController.signal, externalSignal: options.signal };

    try {
      for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
        const response = await this.#fetch(url, requestOptions);
        if (!isRedirect(response.status)) {
          const body = await this.#readBody(response, requestOptions);
          const sha256 = digest("sha256", body, "hex");
          verifyIntegrity(body, options.integrity);
          return {
            url: url.href,
            status: response.status,
            ok: response.ok,
            redirected: redirects.length > 0,
            redirects,
            headers: Object.fromEntries(response.headers.entries()),
            body,
            sha256
          };
        }

        const location = response.headers.get("location");
        if (!location) throw new HostFetchError("redirect without location", { code: "EBADREDIRECT", url: url.href, status: response.status });
        const next = this.policy.assertAllowed(new URL(location, url).href);
        redirects.push({ from: url.href, to: next.href, status: response.status });
        url = next;
      }

      throw new HostFetchError("too many redirects", { code: "ETOOMANYREDIRECTS", url: url.href });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #fetch(url, options) {
    try {
      return await this.fetchImpl(url.href, {
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body,
        redirect: "manual",
        signal: options.signal
      });
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

  async #readBody(response, options) {
    const maxBytes = options.maxBytes ?? this.policy.maxBytes;
    const bytes = [];
    let total = 0;

    try {
      for await (const chunk of response.body || []) {
        const current = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
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

export function verifyIntegrity(body, integrity) {
  if (!integrity) return true;
  const [algorithm, expected] = integrity.split("-", 2);
  if (!algorithm || !expected) throw new HostFetchError(`unsupported integrity: ${integrity}`, { code: "EBADINTEGRITY" });
  const actual = digest(algorithm, body, expected.length === 64 ? "hex" : "base64");
  if (actual !== expected) {
    throw new HostFetchError(`integrity mismatch for ${algorithm}`, { code: "EINTEGRITY" });
  }
  return true;
}

function digest(algorithm, body, encoding) {
  return crypto.createHash(algorithm).update(body).digest(encoding);
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export { FetchPolicy, FetchPolicyError };
