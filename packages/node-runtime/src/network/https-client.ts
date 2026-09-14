import { RuntimeHttpClient } from "./http-client.ts";

export class RuntimeHttpsClient extends RuntimeHttpClient {}

export function createHttpsClient(fetcher) {
  return new RuntimeHttpsClient(fetcher);
}

