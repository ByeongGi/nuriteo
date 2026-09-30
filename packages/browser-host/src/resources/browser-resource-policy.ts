export const WASM_PAGE_BYTES = 64 * 1024;
export const DEFAULT_BROWSER_RUNTIME_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
export const DEFAULT_BROWSER_WASM_MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

export interface BrowserRuntimeResourceEstimate {
  artifactBytes?: number;
  sourceBytes?: number;
  wasmMemoryBytes?: number;
  workspaceBytes?: number;
}

export interface BrowserRuntimeResourceAdmission {
  limitBytes: number;
  totalBytes: number;
  breakdown: Required<BrowserRuntimeResourceEstimate>;
}

export class BrowserRuntimeResourceError extends Error {
  readonly code: "ERUNTIME_RESOURCE_ESTIMATE" | "ERUNTIME_MEMORY_ADMISSION" | "ERUNTIME_WASM_MEMORY";
  readonly limitBytes: number;
  readonly observedBytes: number;

  constructor(
    message: string,
    code: BrowserRuntimeResourceError["code"],
    observedBytes: number,
    limitBytes: number
  ) {
    super(message);
    this.name = "BrowserRuntimeResourceError";
    this.code = code;
    this.observedBytes = observedBytes;
    this.limitBytes = limitBytes;
  }
}

export function assertBrowserRuntimeResourceAdmission(
  estimate: BrowserRuntimeResourceEstimate,
  limitBytes = DEFAULT_BROWSER_RUNTIME_MEMORY_LIMIT_BYTES
): BrowserRuntimeResourceAdmission {
  const limit = positiveSafeInteger(limitBytes, "browser runtime memory limit");
  const breakdown = {
    artifactBytes: resourceBytes(estimate.artifactBytes, "artifactBytes"),
    sourceBytes: resourceBytes(estimate.sourceBytes, "sourceBytes"),
    wasmMemoryBytes: resourceBytes(estimate.wasmMemoryBytes, "wasmMemoryBytes"),
    workspaceBytes: resourceBytes(estimate.workspaceBytes, "workspaceBytes")
  };
  const totalBytes = Object.values(breakdown).reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(totalBytes)) {
    throw new BrowserRuntimeResourceError(
      "Browser runtime resource estimate exceeds the safe integer range.",
      "ERUNTIME_RESOURCE_ESTIMATE",
      totalBytes,
      limit
    );
  }
  if (totalBytes > limit) {
    throw new BrowserRuntimeResourceError(
      `Browser runtime resource admission rejected ${totalBytes} bytes; limit is ${limit} bytes.`,
      "ERUNTIME_MEMORY_ADMISSION",
      totalBytes,
      limit
    );
  }
  return { limitBytes: limit, totalBytes, breakdown };
}

export function createBoundedWebAssemblyMemoryConstructor(
  limitBytes = DEFAULT_BROWSER_WASM_MEMORY_LIMIT_BYTES,
  NativeMemory: typeof WebAssembly.Memory = WebAssembly.Memory
): typeof WebAssembly.Memory {
  const limit = positiveSafeInteger(limitBytes, "WebAssembly memory limit");
  const maximumPages = Math.floor(limit / WASM_PAGE_BYTES);
  if (maximumPages < 1) {
    throw new BrowserRuntimeResourceError(
      `WebAssembly memory limit must allow at least one ${WASM_PAGE_BYTES}-byte page.`,
      "ERUNTIME_WASM_MEMORY",
      limit,
      WASM_PAGE_BYTES
    );
  }

  return new Proxy(NativeMemory, {
    construct(target, argumentsList, newTarget) {
      const input = argumentsList[0];
      if (!input || typeof input !== "object") return Reflect.construct(target, argumentsList, newTarget);
      const descriptor = { ...(input as WebAssembly.MemoryDescriptor & { minimum?: number; index?: string }) };
      if (descriptor.index === "i64") {
        throw new BrowserRuntimeResourceError(
          "memory64 WebAssembly memories are outside the browser runtime support contract.",
          "ERUNTIME_WASM_MEMORY",
          limit + 1,
          limit
        );
      }
      const initial = descriptor.initial ?? descriptor.minimum;
      if (!Number.isSafeInteger(initial) || Number(initial) < 0 || Number(initial) > maximumPages) {
        throw new BrowserRuntimeResourceError(
          `WebAssembly initial memory ${String(initial)} pages exceeds the ${maximumPages}-page product limit.`,
          "ERUNTIME_WASM_MEMORY",
          Number(initial) * WASM_PAGE_BYTES,
          limit
        );
      }
      if (descriptor.initial === undefined && descriptor.minimum !== undefined) {
        descriptor.initial = descriptor.minimum;
        delete descriptor.minimum;
      }
      if (descriptor.maximum !== undefined && (!Number.isSafeInteger(descriptor.maximum) || descriptor.maximum < 0 || descriptor.maximum > maximumPages)) {
        throw new BrowserRuntimeResourceError(
          `WebAssembly maximum memory ${String(descriptor.maximum)} pages exceeds the ${maximumPages}-page product limit.`,
          "ERUNTIME_WASM_MEMORY",
          Number(descriptor.maximum) * WASM_PAGE_BYTES,
          limit
        );
      }
      descriptor.maximum ??= maximumPages;
      return Reflect.construct(target, [descriptor], newTarget);
    }
  });
}

export function installWebAssemblyMemoryLimit(
  limitBytes = DEFAULT_BROWSER_WASM_MEMORY_LIMIT_BYTES
): { limitBytes: number; maximumPages: number } {
  const current = WebAssembly.Memory as typeof WebAssembly.Memory & { __nuriteoLimitBytes?: number };
  if (current.__nuriteoLimitBytes !== undefined) {
    if (current.__nuriteoLimitBytes !== limitBytes) {
      throw new BrowserRuntimeResourceError(
        `WebAssembly memory limit is already installed at ${current.__nuriteoLimitBytes} bytes.`,
        "ERUNTIME_WASM_MEMORY",
        current.__nuriteoLimitBytes,
        limitBytes
      );
    }
    return { limitBytes, maximumPages: Math.floor(limitBytes / WASM_PAGE_BYTES) };
  }
  const bounded = createBoundedWebAssemblyMemoryConstructor(limitBytes, current) as typeof current;
  Object.defineProperty(bounded, "__nuriteoLimitBytes", { value: limitBytes });
  Object.defineProperty(WebAssembly, "Memory", {
    ...Object.getOwnPropertyDescriptor(WebAssembly, "Memory"),
    value: bounded
  });
  return { limitBytes, maximumPages: Math.floor(limitBytes / WASM_PAGE_BYTES) };
}

function resourceBytes(value: number | undefined, name: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BrowserRuntimeResourceError(
      `Invalid browser runtime resource estimate ${name}: ${String(value)}.`,
      "ERUNTIME_RESOURCE_ESTIMATE",
      value,
      DEFAULT_BROWSER_RUNTIME_MEMORY_LIMIT_BYTES
    );
  }
  return value;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BrowserRuntimeResourceError(
      `Invalid ${name}: ${String(value)}.`,
      "ERUNTIME_RESOURCE_ESTIMATE",
      value,
      DEFAULT_BROWSER_RUNTIME_MEMORY_LIMIT_BYTES
    );
  }
  return value;
}
