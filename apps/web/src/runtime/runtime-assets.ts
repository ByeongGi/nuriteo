const CONTENT_HASH = /^[0-9a-f]{64}$/u;
const MANIFEST_MAX_BYTES = 256 * 1024;
const MANIFEST_TIMEOUT_MS = 5_000;

interface RuntimeAssetManifest {
  schemaVersion: 1;
  revision: string;
}

export async function resolveRuntimeAssetRevision(
  configuredRevision?: string,
  signal?: AbortSignal,
  credentials: RequestCredentials = "same-origin"
): Promise<string> {
  if (configuredRevision !== undefined) return validateRevision(configuredRevision);

  const requestAbort = new AbortController();
  const onExternalAbort = () => requestAbort.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => requestAbort.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch("/runtime/manifest.json", {
      cache: "no-store",
      credentials,
      signal: requestAbort.signal
    });
    if (!response.ok) {
      throw new RuntimeAssetError("RUNTIME_ASSET_MANIFEST_UNAVAILABLE", "Runtime assets are unavailable.");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MANIFEST_MAX_BYTES) {
      throw new RuntimeAssetError("RUNTIME_ASSET_MANIFEST_INVALID", "Runtime asset metadata is invalid.");
    }
    const body = await readBoundedText(response, MANIFEST_MAX_BYTES);
    let manifest: unknown;
    try { manifest = JSON.parse(body); } catch {
      throw new RuntimeAssetError("RUNTIME_ASSET_MANIFEST_INVALID", "Runtime asset metadata is invalid.");
    }
    if (!isManifest(manifest)) {
      throw new RuntimeAssetError("RUNTIME_ASSET_MANIFEST_INVALID", "Runtime asset metadata is invalid.");
    }
    return validateRevision(manifest.revision);
  } catch (error) {
    if (error instanceof RuntimeAssetError) throw error;
    throw new RuntimeAssetError("RUNTIME_ASSET_MANIFEST_UNAVAILABLE", "Runtime assets are unavailable.");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

export class RuntimeAssetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeAssetError";
    this.code = code;
  }
}

function validateRevision(value: string): string {
  if (!CONTENT_HASH.test(value)) {
    throw new RuntimeAssetError("RUNTIME_ASSET_REVISION_INVALID", "Runtime asset revision is invalid.");
  }
  return value;
}

function isManifest(value: unknown): value is RuntimeAssetManifest {
  return typeof value === "object"
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.get(value, "schemaVersion") === 1
    && typeof Reflect.get(value, "revision") === "string";
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new RuntimeAssetError("RUNTIME_ASSET_MANIFEST_INVALID", "Runtime asset metadata is invalid.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new RuntimeAssetError("RUNTIME_ASSET_MANIFEST_INVALID", "Runtime asset metadata is invalid.");
  }
}
