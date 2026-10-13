export interface LookupAddress {
  address: string;
  family: 4 | 6;
}

export interface LookupOptions {
  all?: boolean;
  family?: 0 | 4 | 6;
  verbatim?: boolean;
}

export type LookupCallback = (error: Error | null, address: string, family: 4 | 6) => void;
export type LookupAllCallback = (error: Error | null, addresses: LookupAddress[]) => void;

export function lookup(hostname: string, callback: LookupCallback): void;
export function lookup(hostname: string, options: LookupOptions, callback: LookupCallback | LookupAllCallback): void;
export function lookup(
  hostname: string,
  optionsOrCallback: LookupOptions | LookupCallback,
  maybeCallback?: LookupCallback | LookupAllCallback
): void {
  const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
  const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
  if (!callback) throw new TypeError("dns.lookup callback is required");

  queueMicrotask(() => {
    const address = resolveBrowserSafeAddress(hostname, options.family);
    if (options.all) {
      (callback as LookupAllCallback)(null, [address]);
    } else {
      (callback as LookupCallback)(null, address.address, address.family);
    }
  });
}

export const promises = Object.freeze({
  lookup(hostname: string, options: LookupOptions = {}): Promise<string | LookupAddress | LookupAddress[]> {
    return new Promise((resolve, reject) => {
      lookup(hostname, options, (error, addressOrAddresses, family) => {
        if (error) {
          reject(error);
          return;
        }
        if (Array.isArray(addressOrAddresses)) resolve(addressOrAddresses);
        else if (options.all) resolve([{ address: addressOrAddresses, family: family || options.family || 4 }]);
        else if (options.family) resolve(addressOrAddresses);
        else resolve({ address: addressOrAddresses, family: family || 4 });
      });
    });
  }
});

export const dnsBuiltin = Object.freeze({
  ADDRCONFIG: 32,
  V4MAPPED: 8,
  lookup,
  promises
});

export const dnsPromisesBuiltin = promises;

function resolveBrowserSafeAddress(hostname: string, family: LookupOptions["family"] = 0): LookupAddress {
  if (family === 6) return { address: "::1", family: 6 };
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return { address: "127.0.0.1", family: 4 };
  return { address: "0.0.0.0", family: 4 };
}
