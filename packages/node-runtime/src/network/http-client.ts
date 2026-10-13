import type { HostDownloadResult, HostFetchOptions } from "../../../browser-host/src/io/index.ts";

export interface RuntimeFetcher {
  download(input: string | URL, options?: HostFetchOptions): Promise<HostDownloadResult>;
}

export class RuntimeHttpClient {
  fetcher: RuntimeFetcher;

  constructor(fetcher: RuntimeFetcher) {
    this.fetcher = fetcher;
  }

  get(url: string | URL, options: HostFetchOptions = {}): Promise<HostDownloadResult> {
    return this.fetcher.download(url, { ...options, method: "GET" });
  }
}

export function createHttpClient(fetcher: RuntimeFetcher): RuntimeHttpClient {
  return new RuntimeHttpClient(fetcher);
}
