import { createHash } from "../builtins/crypto.ts";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha512Base64(bytes: Uint8Array | string): string {
  return createHash("sha512").update(bytes).digest("base64");
}

export function integritySha512(bytes: Uint8Array | string): string {
  return `sha512-${sha512Base64(bytes)}`;
}
