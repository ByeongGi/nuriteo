import { requestSync } from "./sync-client.ts";
import type { DecodedFrame, SyncRequestOptions } from "./types.ts";

export async function requestAsync(channel: SharedArrayBuffer, request: Parameters<typeof requestSync>[1], options: SyncRequestOptions = {}): Promise<DecodedFrame> {
  return requestSync(channel, request, options);
}
