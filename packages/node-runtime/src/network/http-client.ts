export class RuntimeHttpClient {
  constructor(fetcher) {
    this.fetcher = fetcher;
  }

  get(url, options = {}) {
    return this.fetcher.download(url, { ...options, method: "GET" });
  }
}

export function createHttpClient(fetcher) {
  return new RuntimeHttpClient(fetcher);
}

