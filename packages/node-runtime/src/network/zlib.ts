import { gunzipSync, gzipSync } from "../builtins/zlib.ts";

export function gunzip(bytes: Uint8Array): Uint8Array {
  return gunzipSync(bytes);
}

export function gzip(bytes: Uint8Array): Uint8Array {
  return gzipSync(bytes);
}
