import { createCliNestedWorkerRuntime, type CliNestedWorkerRequest } from "../packages/node-runtime/src/package-managers/cli-evaluator.ts";

let runtime: ReturnType<typeof createCliNestedWorkerRuntime> | null = null;
const queuedMessages: unknown[] = [];

self.addEventListener("message", (event: MessageEvent) => {
  if (!runtime) {
    const data = event.data as { type?: string; request?: CliNestedWorkerRequest };
    if (data?.type === "cli:nested:init" && data.request) {
      runtime = createCliNestedWorkerRuntime(data.request, {
        postMessage: (value) => self.postMessage(value)
      });
      for (const value of queuedMessages) runtime.postMessage(value);
      queuedMessages.length = 0;
      runtime.ready.catch((error) => {
        self.postMessage({ __cargoNestedWorkerError: error instanceof Error ? error.stack || error.message : String(error) });
      });
    } else {
      queuedMessages.push(event.data);
    }
    return;
  }
  runtime.postMessage(event.data);
});
