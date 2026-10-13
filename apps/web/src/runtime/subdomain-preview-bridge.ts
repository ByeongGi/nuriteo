import { init as initializeModuleLexer, parse as parseModuleImports } from "es-module-lexer";

import {
  createPreviewOriginUrl,
  parseInternalPreviewUrl
} from "./preview-origin-contract.ts";
import type {
  EnabledPreviewOriginConfiguration,
  PreviewHostBinding
} from "./preview-origin-contract.ts";

const PROTOCOL_VERSION = 1;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS = 4;
const RELAY_TIMEOUT_MS = 10_000;
const DISPOSE_ACK_TIMEOUT_MS = 2_000;
const REQUEST_ID = /^r-[a-z2-7]{45}-p[1-9][0-9]{0,4}:[1-9][0-9]{0,9}$/u;
const NONCE = /^[0-9a-f]{32}$/u;

export interface SubdomainPreviewBridge {
  readonly binding: PreviewHostBinding;
  readonly url: string;
  attach(target: Window | null): void;
  hotUpdate(path: string): void;
  dispose(): Promise<void>;
}

interface PublishedExampleBinding {
  readonly publicId: string;
  readonly versionNumber: number;
}

export async function createSubdomainPreviewBridge(options: {
  configuration: EnabledPreviewOriginConfiguration;
  internalProjectIdentity: string;
  internalPreviewUrl: string;
  ownerId: string;
  ownerType: "organization" | "user";
  projectId: string;
  onDiagnostic?(code: string): void;
  onRecoveryRequired?(): void;
}): Promise<SubdomainPreviewBridge> {
  return createPreviewBridge(options, (port) => issueProjectBinding(options, port));
}

export async function createPublishedExamplePreviewBridge(options: {
  configuration: EnabledPreviewOriginConfiguration;
  internalProjectIdentity: string;
  internalPreviewUrl: string;
  publicId: string;
  versionNumber: number;
  onDiagnostic?(code: string): void;
  onRecoveryRequired?(): void;
}): Promise<SubdomainPreviewBridge> {
  return createPreviewBridge(options, (port) => issuePublishedExampleBinding(options, port));
}

async function createPreviewBridge(
  options: {
    configuration: EnabledPreviewOriginConfiguration;
    internalProjectIdentity: string;
    internalPreviewUrl: string;
    onDiagnostic?(code: string): void;
    onRecoveryRequired?(): void;
  },
  issuePreviewBinding: (port: number) => Promise<{ expiresAtMonotonic: number; runtimeId: string }>
): Promise<SubdomainPreviewBridge> {
  const internal = parseInternalPreviewUrl(
    options.internalPreviewUrl,
    options.internalProjectIdentity,
    options.configuration.applicationOrigin
  );
  const port = internal.port;
  const issuedBinding = await issuePreviewBinding(port);
  const runtimeId = issuedBinding.runtimeId;
  const { binding, url } = createPreviewOriginUrl(options.configuration, runtimeId, port);
  const previewOrigin = new URL(url).origin;
  const seenNonces = new Set<string>();
  const abort = new AbortController();
  let target: Window | null = null;
  let relayPort: MessagePort | null = null;
  let activeNonce: string | null = null;
  let inFlightRequests = 0;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let acknowledgeDispose: (() => void) | null = null;
  let hotUpdateSequence = 0;
  let relayRequestHighWater = 0;

  function attach(value: Window | null): void { target = value; }

  function hotUpdate(path: string): void {
    if (disposed || !relayPort || !activeNonce) return;
    if (!path.startsWith("src/") || path.length > 512 || path.includes("..") || path.includes("\\")) return;
    relayPort.postMessage({
      type: "nuriteo-preview:hmr",
      version: PROTOCOL_VERSION,
      binding: binding.label,
      generation: binding.runtimeId,
      nonce: activeNonce,
      path,
      sequence: ++hotUpdateSequence
    });
  }

  function receiveHandshake(event: MessageEvent): void {
    if (disposed || event.origin !== previewOrigin || event.source !== target) return;
    if (isRecoveryMessage(event.data, binding.label, binding.runtimeId)) {
      options.onRecoveryRequired?.();
      return;
    }
    if (event.ports.length !== 1) return;
    if (!isConnectMessage(event.data, binding.label) || seenNonces.has(event.data.nonce)) return;
    if (performance.now() >= issuedBinding.expiresAtMonotonic) {
      event.ports[0]?.close();
      options.onRecoveryRequired?.();
      return;
    }
    seenNonces.add(event.data.nonce);
    relayPort?.close();
    activeNonce = event.data.nonce;
    relayPort = event.ports[0] ?? null;
    if (!relayPort) return;
    relayRequestHighWater = 0;
    const acceptedPort = relayPort;
    relayPort.onmessage = (relayEvent) => {
      if (isDisposedMessage(relayEvent.data, binding.label, binding.runtimeId, activeNonce)) {
        acknowledgeDispose?.();
        return;
      }
      void receiveRelayRequest(relayEvent.data, acceptedPort);
    };
    relayPort.start();
    relayPort.postMessage({
      type: "nuriteo-preview:ready",
      version: PROTOCOL_VERSION,
      binding: binding.label,
      generation: binding.runtimeId,
      nonce: activeNonce
    });
  }

  async function receiveRelayRequest(value: unknown, responsePort: MessagePort): Promise<void> {
    if (disposed || relayPort !== responsePort || !isRelayRequest(value, binding.label)) return;
    const requestSequence = Number(value.id.slice(value.id.lastIndexOf(":") + 1));
    if (!Number.isSafeInteger(requestSequence) || requestSequence <= relayRequestHighWater) return;
    relayRequestHighWater = requestSequence;
    if (inFlightRequests >= MAX_IN_FLIGHT_REQUESTS) {
      postFailure(responsePort, value.id, 429, "Preview relay capacity exceeded");
      return;
    }
    inFlightRequests += 1;
    const requestAbort = new AbortController();
    const timeout = setTimeout(() => requestAbort.abort(), RELAY_TIMEOUT_MS);
    const onDispose = () => requestAbort.abort();
    abort.signal.addEventListener("abort", onDispose, { once: true });
    try {
      const internalUrl = new URL(value.path.slice(1), internal.baseUrl);
      const internalBase = new URL(internal.baseUrl);
      if (internalUrl.origin !== internalBase.origin || !internalUrl.pathname.startsWith(internalBase.pathname)) {
        throw new Error("Preview relay path escaped its session");
      }
      const response = await fetch(internalUrl, {
        cache: "no-store",
        credentials: "omit",
        method: value.method,
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: requestAbort.signal
      });
      let body = value.method === "HEAD" ? new Uint8Array() : await readBoundedBody(response, MAX_RESPONSE_BYTES);
      const contentType = response.headers.get("content-type") ?? "";
      let scriptNonce: string | undefined;
      if ((value.destination === "document" || value.destination === "iframe") && contentType.startsWith("text/html")) {
        const transformed = injectHmrClient(body);
        body = transformed.body;
        scriptNonce = transformed.scriptNonce;
      } else if (contentType.includes("javascript")) {
        body = await rewriteModuleImports(body, value.path);
      }
      const transferable = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      responsePort.postMessage({
        type: "nuriteo-preview:response",
        version: PROTOCOL_VERSION,
        id: value.id,
        status: response.status,
        headers: responseHeaders(response.headers, scriptNonce),
        body: transferable
      }, [transferable]);
    } catch {
      if (!disposed) {
        postFailure(responsePort, value.id, 502, "Preview relay unavailable");
      }
    } finally {
      inFlightRequests -= 1;
      clearTimeout(timeout);
      abort.signal.removeEventListener("abort", onDispose);
    }
  }

  async function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true;
    globalThis.removeEventListener("message", receiveHandshake);
    disposePromise = (async () => {
      const port = relayPort;
      const nonce = activeNonce;
      if (port && nonce) {
        const acknowledged = new Promise<void>((resolve) => { acknowledgeDispose = resolve; });
        port.postMessage({
          type: "nuriteo-preview:dispose",
          version: PROTOCOL_VERSION,
          binding: binding.label,
          generation: binding.runtimeId,
          nonce
        });
        await Promise.race([
          acknowledged,
          new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_ACK_TIMEOUT_MS))
        ]);
      }
      abort.abort();
      port?.close();
      relayPort = null;
      target = null;
      acknowledgeDispose = null;
      const remainingLifetime = issuedBinding.expiresAtMonotonic - performance.now();
      if (remainingLifetime > 0) await new Promise((resolve) => setTimeout(resolve, remainingLifetime));
    })();
    return disposePromise;
  }

  globalThis.addEventListener("message", receiveHandshake);
  return { binding, url, attach, hotUpdate, dispose };
}

function isRecoveryMessage(value: unknown, binding: string, generation: string): boolean {
  return isExactRecord(value, ["binding", "generation", "type", "version"])
    && value.type === "nuriteo-preview:recovery-required"
    && value.version === PROTOCOL_VERSION
    && value.binding === binding
    && value.generation === generation;
}

function postFailure(port: MessagePort, id: string, status: number, message: string): void {
  port.postMessage({
    type: "nuriteo-preview:response",
    version: PROTOCOL_VERSION,
    id,
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    body: new TextEncoder().encode(message).buffer
  });
}

function isConnectMessage(value: unknown, binding: string): value is { binding: string; generation: string; nonce: string; type: string; version: number } {
  return isExactRecord(value, ["binding", "generation", "nonce", "type", "version"])
    && value.type === "nuriteo-preview:connect"
    && value.version === PROTOCOL_VERSION
    && value.binding === binding
    && value.generation === runtimeIdFromBinding(binding)
    && typeof value.nonce === "string"
    && NONCE.test(value.nonce);
}

function isDisposedMessage(
  value: unknown,
  binding: string,
  generation: string,
  nonce: string | null
): boolean {
  return isExactRecord(value, ["binding", "generation", "nonce", "type", "version"])
    && value.type === "nuriteo-preview:disposed"
    && value.version === PROTOCOL_VERSION
    && value.binding === binding
    && value.generation === generation
    && value.nonce === nonce;
}

function isRelayRequest(value: unknown, binding: string): value is { binding: string; destination: string; id: string; method: "GET" | "HEAD"; path: string; type: string; version: number } {
  return isExactRecord(value, ["binding", "destination", "id", "method", "path", "type", "version"])
    && value.type === "nuriteo-preview:request"
    && value.version === PROTOCOL_VERSION
    && value.binding === binding
    && typeof value.id === "string"
    && REQUEST_ID.test(value.id)
    && value.id.startsWith(`${binding}:`)
    && (value.method === "GET" || value.method === "HEAD")
    && typeof value.destination === "string"
    && /^[a-z]{0,20}$/u.test(value.destination)
    && typeof value.path === "string"
    && value.path.startsWith("/")
    && value.path.length <= 2_048;
}

function injectHmrClient(body: Uint8Array): { body: Uint8Array; scriptNonce: string } {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const scriptNonce = randomNonce();
  const nonceScripts = html.replace(/<script\b([^>]*)>/giu, (_tag, attributes: string) => {
    const withoutNonce = attributes.replace(/\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "");
    return `<script${withoutNonce} nonce="${scriptNonce}">`;
  });
  const script = `<script src="/runtime-preview/hmr.js" nonce="${scriptNonce}" defer></script>`;
  const injected = /<\/body>/iu.test(nonceScripts) ? nonceScripts.replace(/<\/body>/iu, `${script}</body>`) : `${nonceScripts}${script}`;
  const result = new TextEncoder().encode(injected);
  if (result.byteLength > MAX_RESPONSE_BYTES) throw new Error("Preview response exceeds limit");
  return { body: result, scriptNonce };
}

async function rewriteModuleImports(body: Uint8Array, requestPath: string): Promise<Uint8Array> {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const imports: Readonly<Record<string, string>> = {
    react: "/node_modules/react/index.js",
    "react-dom": "/node_modules/react-dom/client.js",
    "react-dom/client": "/node_modules/react-dom/client.js",
    "react/jsx-runtime": "/node_modules/react/jsx-runtime.js",
    "react/jsx-dev-runtime": "/node_modules/react/jsx-runtime.js"
  };
  const version = new URL(requestPath, "http://preview.invalid").searchParams.get("nuriteo_hmr");
  const validVersion = version && /^[1-9][0-9]{0,9}$/u.test(version) ? version : undefined;
  await initializeModuleLexer;
  const [parsedImports] = parseModuleImports(source);
  let rewritten = "";
  let offset = 0;
  for (const parsed of parsedImports) {
    const specifier = parsed.n;
    if (specifier === undefined) continue;
    const replacement = imports[specifier]
      ?? (validVersion && /^\.\.?\//u.test(specifier) && !specifier.includes("?")
        ? `${specifier}?nuriteo_hmr=${validVersion}`
        : specifier);
    const encodedReplacement = parsed.d >= 0 ? JSON.stringify(replacement) : replacement;
    rewritten += source.slice(offset, parsed.s) + encodedReplacement;
    offset = parsed.e;
  }
  rewritten += source.slice(offset);
  const result = new TextEncoder().encode(rewritten);
  if (result.byteLength > MAX_RESPONSE_BYTES) throw new Error("Preview response exceeds limit");
  return result;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Preview response exceeds limit");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function responseHeaders(headers: Headers, scriptNonce?: string): Record<string, string> {
  const result: Record<string, string> = { "cache-control": "no-store" };
  const contentType = headers.get("content-type");
  if (contentType) result["content-type"] = contentType;
  if (scriptNonce) result["x-nuriteo-script-nonce"] = scriptNonce;
  return result;
}

function randomNonce(): string {
  const value = new Uint8Array(16);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function issueProjectBinding(
  options: {
    configuration: EnabledPreviewOriginConfiguration;
    ownerId: string;
    ownerType: "organization" | "user";
    projectId: string;
  },
  port: number
): Promise<{ expiresAtMonotonic: number; runtimeId: string }> {
  const csrf = readCsrfCredential();
  return requestBinding(
    new URL("/api/runtime-preview/bindings", options.configuration.applicationOrigin),
    { ownerId: options.ownerId, ownerType: options.ownerType, port, projectId: options.projectId },
    { credentials: "same-origin", csrf }
  );
}

async function issuePublishedExampleBinding(
  options: { configuration: EnabledPreviewOriginConfiguration } & PublishedExampleBinding,
  port: number
): Promise<{ expiresAtMonotonic: number; runtimeId: string }> {
  return requestBinding(
    new URL("/api/runtime-preview/public-bindings", options.configuration.applicationOrigin),
    { port, publicId: options.publicId, versionNumber: options.versionNumber },
    { credentials: "omit" }
  );
}

async function requestBinding(
  url: URL,
  body: Readonly<Record<string, string | number>>,
  security: { readonly credentials: RequestCredentials; readonly csrf?: string }
): Promise<{ expiresAtMonotonic: number; runtimeId: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (security.csrf !== undefined) headers["x-csrf-token"] = security.csrf;
  const response = await fetch(url, {
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: security.credentials,
    headers,
    method: "POST",
    redirect: "error"
  });
  const responseBody = await response.text();
  if (!response.ok || responseBody.length > 1_024) throw new Error("Preview binding unavailable");
  let parsed: unknown;
  try { parsed = JSON.parse(responseBody); } catch { throw new Error("Preview binding unavailable"); }
  if (!isExactRecord(parsed, ["runtimeId", "ttlMs"])
      || typeof parsed.runtimeId !== "string"
      || !/^[a-z2-7]{45}$/u.test(parsed.runtimeId)
      || typeof parsed.ttlMs !== "number"
      || !Number.isSafeInteger(parsed.ttlMs)
      || parsed.ttlMs < 1
      || parsed.ttlMs > 30_000) {
    throw new Error("Preview binding unavailable");
  }
  return { expiresAtMonotonic: performance.now() + parsed.ttlMs, runtimeId: parsed.runtimeId };
}

function runtimeIdFromBinding(binding: string): string | undefined {
  return /^r-([a-z2-7]{45})-p[1-9][0-9]{0,4}$/u.exec(binding)?.[1];
}

function readCsrfCredential(): string {
  for (const pair of document.cookie.split(";")) {
    const [name, value] = pair.trim().split("=", 2);
    if ((name === "__Host-nuriteo_csrf" || name === "nuriteo_dev_csrf") && value && /^nrt_csrf_[A-Za-z0-9_-]{43}$/u.test(value)) return value;
  }
  throw new Error("Preview browser credential unavailable");
}
