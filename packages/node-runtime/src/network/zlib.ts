import zlib from "node:zlib";

export function gunzip(bytes) {
  return zlib.gunzipSync(bytes);
}

export function gzip(bytes) {
  return zlib.gzipSync(bytes);
}

