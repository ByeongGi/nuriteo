import { createCliNestedWorkerRuntime, type CliNestedWorkerRequest } from "../packages/node-runtime/src/package-managers/cli-evaluator.ts";
import { installWebAssemblyMemoryLimit } from "../packages/browser-host/src/resources/index.ts";

installWebAssemblyMemoryLimit();

let runtime: ReturnType<typeof createCliNestedWorkerRuntime> | null = null;
const queuedMessages: unknown[] = [];
let initializing = false;

self.addEventListener("message", (event: MessageEvent) => {
  if (!runtime) {
    const data = event.data as { type?: string; request?: CliNestedWorkerRequest };
    if (data?.type === "cli:nested:init" && data.request && !initializing) {
      initializing = true;
      initialize(data.request).catch((error) => {
        self.postMessage({ __nuriteoNestedWorkerError: error instanceof Error ? error.stack || error.message : String(error) });
      });
    } else {
      queuedMessages.push(event.data);
    }
    return;
  }
  runtime.postMessage(event.data);
});

async function initialize(request: CliNestedWorkerRequest): Promise<void> {
  const options = request.filename.includes("/node_modules/next/")
    ? await loadPinnedNextFactories()
    : {};
  runtime = createCliNestedWorkerRuntime(request, {
    postMessage: (value) => self.postMessage(value)
  }, options);
  for (const value of queuedMessages) runtime.postMessage(value);
  queuedMessages.length = 0;
  await runtime.ready;
}

async function loadPinnedNextFactories() {
  const factoryUrl = new URL("../vendor/next-cli-15.5.26.mjs", self.location.href);
  const response = await fetch(factoryUrl, { cache: "no-store" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || await sha256(bytes) !== "0c103d7af3c610283437fd6f326f5b6b9aa8aa53880926a7e509d2433c515224") {
    throw new Error("ERR_NEXT_CSP_NESTED_FACTORY_INTEGRITY");
  }
  const factories = await import(/* @vite-ignore */ factoryUrl.href);
  if (factories.nextVersion !== "15.5.26") throw new Error("ERR_NEXT_CSP_NESTED_FACTORY_MISMATCH");
  return {
    precompiledCjsFactories: factories.cjsFactories,
    precompiledEsmFactories: factories.esmFactories
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
