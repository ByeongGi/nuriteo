import type { HostDownloadResult, HostFetchOptions } from "../../../browser-host/src/io/index.ts";
import { gunzip, integritySha512 } from "../network/index.ts";
import type { RuntimeHttpClient } from "../network/index.ts";

export interface PackageTarballCacheOptions {
  maxEntries?: number;
}

export interface PackageTarballRequest extends HostFetchOptions {
  cacheKey?: string;
  offline?: boolean;
  retries?: number;
}

export interface PackageTarballResult {
  url: string;
  body: Uint8Array;
  sha256: string;
  integrity: string;
  cacheHit: boolean;
  status: number;
}

export interface PackageTarballCacheMetrics {
  downloads: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface TarEntry {
  path: string;
  type: "file" | "directory" | "other";
  body: Uint8Array;
  mode: number;
}

export class PackageTarballCache {
  #entries = new Map<string, PackageTarballResult>();
  #maxEntries: number;
  metrics: PackageTarballCacheMetrics = {
    downloads: 0,
    hits: 0,
    misses: 0,
    evictions: 0
  };

  constructor(options: PackageTarballCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 128;
  }

  async get(client: RuntimeHttpClient, url: string | URL, options: PackageTarballRequest = {}): Promise<PackageTarballResult> {
    const key = options.cacheKey || String(url);
    const cached = this.#entries.get(key);
    if (cached) {
      this.metrics.hits += 1;
      return { ...cached, cacheHit: true };
    }

    this.metrics.misses += 1;
    if (options.offline) throw cacheMiss(key);

    const download = await downloadWithRetry(client, url, options);
    const result: PackageTarballResult = {
      url: download.url,
      body: download.body,
      sha256: download.sha256,
      integrity: options.integrity || integritySha512(download.body),
      cacheHit: false,
      status: download.status
    };
    this.#entries.set(key, result);
    this.#evictIfNeeded();
    this.metrics.downloads += 1;
    return { ...result };
  }

  clear(): void {
    this.#entries.clear();
  }

  #evictIfNeeded(): void {
    while (this.#entries.size > this.#maxEntries) {
      const first = this.#entries.keys().next().value as string | undefined;
      if (!first) return;
      this.#entries.delete(first);
      this.metrics.evictions += 1;
    }
  }
}

export function extractTarEntries(input: Uint8Array): TarEntry[] {
  const bytes = isGzip(input) ? gunzip(input) : input;
  const entries: TarEntry[] = [];
  for (let offset = 0; offset + 512 <= bytes.byteLength;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const path = readString(header, 0, 100);
    const mode = Number.parseInt(readString(header, 100, 8).trim() || "0", 8);
    const size = Number.parseInt(readString(header, 124, 12).trim() || "0", 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    entries.push({
      path,
      type: typeflag === "5" ? "directory" : typeflag === "0" || typeflag === "\0" ? "file" : "other",
      body: bytes.subarray(bodyStart, bodyEnd),
      mode
    });
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function createPackageTarballCache(options: PackageTarballCacheOptions = {}): PackageTarballCache {
  return new PackageTarballCache(options);
}

async function downloadWithRetry(client: RuntimeHttpClient, url: string | URL, options: PackageTarballRequest): Promise<HostDownloadResult> {
  const retries = options.retries ?? 0;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await client.get(url, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function cacheMiss(key: string): Error & { code: string } {
  const error = new Error(`package tarball cache miss: ${key}`) as Error & { code: string };
  error.code = "ECACHEMISS";
  return error;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function readString(bytes: Uint8Array, offset: number, length: number): string {
  const end = offset + length;
  let output = "";
  for (let index = offset; index < end; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0) break;
    output += String.fromCharCode(byte);
  }
  return output;
}
