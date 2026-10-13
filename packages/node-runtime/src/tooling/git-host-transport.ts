export interface GitHostFetchRequest {
  remote: string;
  credentialHandle?: string;
  signal?: AbortSignal;
}

export interface GitHostFetchResponse {
  packfile: Uint8Array;
}

export interface GitHostTransportOptions {
  fetch(request: GitHostFetchRequest): Promise<GitHostFetchResponse>;
  maxPackfileBytes?: number;
}

export interface GitValidatedPackfile {
  packfile: Uint8Array;
  bytes: number;
  version: number;
  objectCount: number;
  remoteOrigin: string;
}

export class GitHostTransportBoundary {
  readonly maxPackfileBytes: number;
  #fetch: GitHostTransportOptions["fetch"];
  #usedCredentials = new Set<string>();

  constructor(options: GitHostTransportOptions) {
    this.maxPackfileBytes = positiveLimit(options.maxPackfileBytes ?? 64 * 1024 * 1024);
    this.#fetch = options.fetch;
  }

  async fetch(remote: string, options: { credentialHandle?: string; signal?: AbortSignal } = {}): Promise<GitValidatedPackfile> {
    const url = safeRemote(remote);
    const credentialHandle = validateCredentialHandle(options.credentialHandle);
    if (credentialHandle) {
      if (this.#usedCredentials.has(credentialHandle)) throw transportError("EGITCREDENTIAL", "Git credential handle was already consumed");
      this.#usedCredentials.add(credentialHandle);
    }
    let response: GitHostFetchResponse;
    try {
      response = await this.#fetch({ remote: url.href, ...(credentialHandle ? { credentialHandle } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    } catch {
      throw transportError("EGITTRANSPORT", "Host-mediated Git fetch failed");
    }
    if (!(response.packfile instanceof Uint8Array)) throw transportError("EGITPACK", "Host returned an invalid Git packfile");
    if (response.packfile.byteLength > this.maxPackfileBytes) {
      throw transportError("EGITPACKLIMIT", `Git packfile exceeds ${this.maxPackfileBytes} bytes`);
    }
    const packfile = copyBytes(response.packfile);
    const header = parsePackHeader(packfile);
    return { packfile, bytes: packfile.byteLength, ...header, remoteOrigin: url.origin };
  }
}

export function createGitHostTransportBoundary(options: GitHostTransportOptions): GitHostTransportBoundary {
  return new GitHostTransportBoundary(options);
}

function safeRemote(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw transportError("EGITREMOTE", "Invalid Git remote URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search) {
    throw transportError("EGITREMOTE", "Git remotes require credential-free HTTPS URLs");
  }
  url.hash = "";
  return url;
}

function validateCredentialHandle(value?: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^git-cred:[a-zA-Z0-9_-]{16,128}$/.test(value)) throw transportError("EGITCREDENTIAL", "Invalid Git credential handle");
  return value;
}

function parsePackHeader(bytes: Uint8Array): { version: number; objectCount: number } {
  if (bytes.byteLength < 12 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "PACK") {
    throw transportError("EGITPACK", "Malformed Git packfile header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, false);
  const objectCount = view.getUint32(8, false);
  if (version !== 2 && version !== 3) throw transportError("EGITPACK", "Unsupported Git packfile version");
  return { version, objectCount };
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 12) throw transportError("EGITPACKLIMIT", "Invalid Git packfile limit");
  return value;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function transportError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
