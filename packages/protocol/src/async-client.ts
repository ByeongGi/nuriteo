import { requestSync } from "./sync-client.ts";

export async function requestAsync(channel, request, options = {}) {
  return requestSync(channel, request, options);
}
