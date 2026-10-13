import { parentPort, workerData } from "node:worker_threads";
import { createCliNestedWorkerRuntime } from "../../packages/node-runtime/src/package-managers/cli-evaluator.ts";

if (!parentPort) throw new Error("Nested CLI worker requires a parent port");

const runtime = createCliNestedWorkerRuntime(workerData, {
  postMessage: (value) => parentPort.postMessage(value)
});

parentPort.on("message", (value) => runtime.postMessage(value));
runtime.ready.catch((error) => {
  parentPort.postMessage({ __nuriteoNestedWorkerError: error instanceof Error ? error.stack || error.message : String(error) });
});
