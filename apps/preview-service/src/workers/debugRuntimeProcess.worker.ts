/// <reference lib="webworker" />

import { FixtureDebugAdapter } from "../lib/dapServer";
import type { DapRequest } from "../lib/dapProtocol";

type HostMessage =
  | { type: "start"; pid: number; generation: number; cwd: string }
  | { type: "dap"; message: DapRequest }
  | { type: "signal"; signal: string };

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const adapter = new FixtureDebugAdapter((message) => workerScope.postMessage({ type: "dap", message }));

workerScope.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  if (event.data.type === "start") {
    workerScope.postMessage({ type: "ready" });
    return;
  }
  if (event.data.type === "dap") {
    adapter.receive(event.data.message);
    return;
  }
  if (event.data.type === "signal") {
    workerScope.postMessage({ type: "exit", code: event.data.signal === "SIGKILL" ? 137 : 143 });
    workerScope.close();
  }
});
