/// <reference lib="webworker" />

import { FixtureDebugAdapter } from "../lib/dapServer";
import type { DapRequest } from "../lib/dapProtocol";

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const adapter = new FixtureDebugAdapter((message) => workerScope.postMessage(message));
workerScope.addEventListener("message", (event: MessageEvent<DapRequest>) => adapter.receive(event.data));
