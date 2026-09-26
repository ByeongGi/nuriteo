/// <reference lib="webworker" />

import { ExtensionWorkerServer } from "../lib/extensionWorkerServer";
import type { JsonRpcMessage } from "../lib/lspProtocol";

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const server = new ExtensionWorkerServer((message) => workerScope.postMessage({ type: "rpc", message }));

workerScope.addEventListener("message", (event: MessageEvent<
  | { type: "start" }
  | { type: "rpc"; message: JsonRpcMessage }
  | { type: "signal"; signal: string }
>) => {
  if (event.data.type === "start") {
    workerScope.postMessage({ type: "ready" });
    return;
  }
  if (event.data.type === "rpc") {
    if (server.receive(event.data.message) === "close") workerScope.close();
    return;
  }
  if (event.data.type === "signal") workerScope.close();
});
