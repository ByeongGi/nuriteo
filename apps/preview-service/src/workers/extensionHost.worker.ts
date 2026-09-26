/// <reference lib="webworker" />

import { ExtensionWorkerServer } from "../lib/extensionWorkerServer";
import type { JsonRpcMessage } from "../lib/lspProtocol";

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const server = new ExtensionWorkerServer((message) => workerScope.postMessage(message));

workerScope.addEventListener("message", (event: MessageEvent<JsonRpcMessage>) => {
  if (server.receive(event.data) === "close") workerScope.close();
});
