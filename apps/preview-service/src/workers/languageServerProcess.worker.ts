/// <reference lib="webworker" />

import { BrowserLspServer } from "../lib/lspServer";
import type { JsonRpcMessage } from "../lib/lspProtocol";

type HostMessage =
  | { type: "start"; pid: number; generation: number; cwd: string }
  | { type: "rpc"; message: JsonRpcMessage }
  | { type: "signal"; signal: string };

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const server = new BrowserLspServer((message) => workerScope.postMessage({ type: "rpc", message }));

workerScope.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  if (event.data.type === "start") {
    workerScope.postMessage({ type: "ready" });
    return;
  }
  if (event.data.type === "rpc") {
    server.receive(event.data.message);
    return;
  }
  if (event.data.type === "signal") {
    workerScope.postMessage({ type: "exit", code: event.data.signal === "SIGKILL" ? 137 : 143 });
    workerScope.close();
  }
});
