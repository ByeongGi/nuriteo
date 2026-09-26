/// <reference lib="webworker" />

import { BrowserLspServer } from "../lib/lspServer";
import type { JsonRpcMessage } from "../lib/lspProtocol";

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const server = new BrowserLspServer((message) => workerScope.postMessage(message));

workerScope.addEventListener("message", (event: MessageEvent<JsonRpcMessage>) => server.receive(event.data));
