import zlib from "node:zlib";

export function gunzip(bytes: Uint8Array): Buffer {
  return zlib.gunzipSync(bytes);
}

export function gzip(bytes: Uint8Array): Buffer {
  return zlib.gzipSync(bytes);
}
