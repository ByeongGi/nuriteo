export class FetchPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "FetchPolicyError";
  }
}

export class FetchPolicy {
  constructor(options = {}) {
    this.allowedHosts = new Set(options.allowedHosts || []);
    this.allowedSchemes = new Set(options.allowedSchemes || ["http:", "https:"]);
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  }

  assertAllowed(input) {
    const url = new URL(input);
    if (!this.allowedSchemes.has(url.protocol)) {
      throw new FetchPolicyError(`blocked URL scheme: ${url.protocol}`);
    }
    if (this.allowedHosts.size > 0 && !this.allowedHosts.has(url.host)) {
      throw new FetchPolicyError(`blocked URL host: ${url.host}`);
    }
    return url;
  }
}

