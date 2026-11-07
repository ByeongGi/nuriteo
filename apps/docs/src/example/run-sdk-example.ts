import { createContainer, type Nuriteo } from "@nuriteo/sdk";

export interface SdkRuntimeUrls {
  systemWorkerUrl: URL;
  processWorkerUrl: URL;
  systemWasmUrl: URL;
}

interface RuntimeManifest {
  revision: string;
}

const AsyncFunction = Object.getPrototypeOf(async function () {
  return undefined;
}).constructor as new (...args: string[]) => (
  createContainer: (options?: Record<string, unknown>) => Nuriteo,
  runtime: SdkRuntimeUrls
) => Promise<unknown>;

export async function runSdkExample(source: string): Promise<unknown> {
  const manifestResponse = await fetch(`${import.meta.env.BASE_URL}runtime/manifest.json`);
  if (!manifestResponse.ok) throw new Error("런타임 자산 매니페스트를 읽지 못했습니다.");
  const manifest = await manifestResponse.json() as RuntimeManifest;
  const base = new URL(`${import.meta.env.BASE_URL}runtime/${manifest.revision}/`, location.origin);
  const runtime: SdkRuntimeUrls = {
    systemWorkerUrl: new URL("system-worker.js", base),
    processWorkerUrl: new URL("process-worker.js", base),
    systemWasmUrl: new URL("system.wasm", base)
  };
  const opened: Nuriteo[] = [];
  const openContainer = (options: Record<string, unknown> = {}) => {
    const container = createContainer({ ...runtime, ...options });
    opened.push(container);
    return container;
  };
  try {
    return await new AsyncFunction("createContainer", "runtime", source)(openContainer, runtime);
  } finally {
    await Promise.all(opened.map((container) => container.teardown().catch(() => undefined)));
  }
}
