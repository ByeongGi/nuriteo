import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  loadPublicPreviewContent,
  MAX_PUBLIC_PREVIEW_PHYSICAL_BYTES,
  PublicPreviewContentError
} from "../src/published-example/public-preview-content.ts";

const publicId = `${"A".repeat(42)}A`;
const versionNumber = 3;
const archive = publicArchive([
  { path: "package.json", kind: "text", mode: "0644", bytes: bytes('{"scripts":{"dev":"vite"}}\n') },
  { path: "src/main.ts", kind: "text", mode: "0644", bytes: bytes('document.body.textContent = "public-preview";\n') }
]);

let observedInit: RequestInit | undefined;
const result = await loadPublicPreviewContent(
  { publicId, versionNumber },
  {
    fetch: async (_input, init) => {
      observedInit = init;
      return publicResponse(archive, versionNumber);
    }
  }
);
assert.equal(observedInit?.credentials, "omit");
assert.equal(new Headers(observedInit?.headers).get("accept"), "application/vnd.nuriteo.published-project-bundle");
assert.deepEqual(result.files.map((file) => file.path), ["package.json", "src/main.ts"]);
assert.equal(new TextDecoder().decode(result.files[1]?.bytes), 'document.body.textContent = "public-preview";\n');

await assert.rejects(
  loadPublicPreviewContent(
    { publicId, versionNumber },
    { fetch: async () => publicResponse(archive, versionNumber, { etagChecksum: "A".repeat(43) }) }
  ),
  (error: unknown) => error instanceof PublicPreviewContentError
    && error.code === "PUBLIC_PREVIEW_INTEGRITY_FAILED"
);

let oversizedCancelled = false;
await assert.rejects(
  loadPublicPreviewContent(
    { publicId, versionNumber },
    {
      fetch: async () => new Response(new ReadableStream({ cancel() { oversizedCancelled = true; } }), {
        headers: publicHeaders(new Uint8Array([1]), versionNumber, {
          contentLength: MAX_PUBLIC_PREVIEW_PHYSICAL_BYTES + 1
        })
      })
    }
  ),
  (error: unknown) => error instanceof PublicPreviewContentError
    && error.code === "PUBLIC_PREVIEW_LIMIT_EXCEEDED"
);
assert.equal(oversizedCancelled, true);

const privateIdentityArchive = publicArchive([], { project: { id: "private", storageScopeId: "private" } });
await assert.rejects(
  loadPublicPreviewContent(
    { publicId, versionNumber },
    { fetch: async () => publicResponse(privateIdentityArchive, versionNumber) }
  ),
  (error: unknown) => error instanceof PublicPreviewContentError
    && error.code === "PUBLIC_PREVIEW_INTEGRITY_FAILED"
);

function publicResponse(
  body: Uint8Array,
  version: number,
  options: { readonly etagChecksum?: string } = {}
): Response {
  return new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, {
    headers: publicHeaders(body, version, options.etagChecksum === undefined
      ? {}
      : { etagChecksum: options.etagChecksum })
  });
}

function publicHeaders(
  body: Uint8Array,
  version: number,
  options: { readonly contentLength?: number; readonly etagChecksum?: string }
): HeadersInit {
  const checksum = options.etagChecksum
    ?? createHash("sha256").update(body).digest("base64url");
  return {
    "cache-control": "no-store",
    "content-length": String(options.contentLength ?? body.byteLength),
    "content-type": "application/vnd.nuriteo.published-project-bundle",
    "cross-origin-resource-policy": "same-origin",
    etag: `"published-content-v${version}-${checksum}"`,
    "x-content-type-options": "nosniff"
  };
}

interface PublicFile {
  readonly bytes: Uint8Array;
  readonly kind: "binary" | "text";
  readonly mode: "0644" | "0755";
  readonly path: string;
}

function publicArchive(files: readonly PublicFile[], extraManifest: Record<string, unknown> = {}): Uint8Array {
  const manifest = {
    format: "nuriteo-published-bundle-v1",
    schemaVersion: 1,
    fileCount: files.length,
    logicalBytes: files.reduce((total, file) => total + file.bytes.byteLength, 0),
    files: files.map((file) => ({
      path: file.path,
      kind: file.kind,
      mode: file.mode,
      sizeBytes: file.bytes.byteLength,
      sha256: createHash("sha256").update(file.bytes).digest("hex")
    })),
    ...extraManifest
  };
  const chunks = [entry("manifest.json", bytes(`${JSON.stringify(manifest)}\n`), 0o644, "0")];
  files.forEach((file, index) => {
    const path = `files/${file.path}`;
    chunks.push(entry(`PaxHeaders/${index.toString().padStart(8, "0")}`, pax(path), 0o644, "x"));
    chunks.push(entry(`files/${index.toString().padStart(8, "0")}`, file.bytes, Number.parseInt(file.mode, 8), "0"));
  });
  chunks.push(new Uint8Array(1024));
  return concat(chunks);
}

function entry(name: string, content: Uint8Array, mode: number, type: "0" | "x"): Uint8Array {
  const header = new Uint8Array(512);
  header.set(bytes(name));
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, content.byteLength);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(bytes("ustar\0"), 257);
  header.set(bytes("00"), 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
  header.set(bytes(checksum), 148);
  header[154] = 0;
  header[155] = 0x20;
  const padding = new Uint8Array(Math.ceil(content.byteLength / 512) * 512 - content.byteLength);
  return concat([header, content, padding]);
}

function pax(path: string): Uint8Array {
  let length = bytes(`path=${path}\n`).byteLength + 2;
  while (true) {
    const record = `${length} path=${path}\n`;
    const encoded = bytes(record);
    if (encoded.byteLength === length) return encoded;
    length = encoded.byteLength;
  }
}

function octal(target: Uint8Array, offset: number, length: number, value: number): void {
  target.set(bytes(value.toString(8).padStart(length - 1, "0")), offset);
  target[offset + length - 1] = 0;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

console.log("public Preview content tests ok");
