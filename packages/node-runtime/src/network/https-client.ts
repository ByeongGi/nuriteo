import { RuntimeHttpClient, type RuntimeFetcher } from "./http-client.ts";

export class RuntimeHttpsClient extends RuntimeHttpClient {}

export function createHttpsClient(fetcher: RuntimeFetcher): RuntimeHttpsClient {
  return new RuntimeHttpsClient(fetcher);
}
