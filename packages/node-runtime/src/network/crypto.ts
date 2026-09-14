import crypto from "node:crypto";

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function sha512Base64(bytes) {
  return crypto.createHash("sha512").update(bytes).digest("base64");
}

export function integritySha512(bytes) {
  return `sha512-${sha512Base64(bytes)}`;
}

