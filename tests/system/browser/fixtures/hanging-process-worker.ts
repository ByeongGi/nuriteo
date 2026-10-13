import { createReadyMessage } from "../../../../packages/protocol/src/messages.ts";
import { OPCODES } from "../../../../packages/protocol/src/generated.ts";
import { requestSync } from "../../../../packages/protocol/src/sync-client.ts";
import { installWebAssemblyMemoryLimit } from "../../../../packages/browser-host/src/resources/index.ts";

installWebAssemblyMemoryLimit();

let systemPort: MessagePort | null = null;
let syncChannel: SharedArrayBuffer | null = null;
let nextRequestId = 1;

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data;
  if (message?.type === "boot") {
    systemPort = message.port;
    syncChannel = message.syncChannel;
    if (!systemPort || !syncChannel) throw new Error("watchdog fixture requires the runtime channels");
    systemPort.start();
    systemPort.onmessage = (portEvent) => {
      if (portEvent.data?.type === "ping") {
        systemPort?.postMessage({ type: "pong", from: "process" });
      } else if (portEvent.data?.type === "run-syscall-ping") {
        const response = requestSync(syncChannel!, {
          requestId: nextRequestId++,
          generation: portEvent.data.generation,
          pid: 1,
          opcode: OPCODES.ping,
          payload: "ping"
        });
        systemPort?.postMessage({
          type: "syscall-result",
          ok: true,
          opcode: response.opcode,
          status: response.status,
          payload: new TextDecoder().decode(response.payload)
        });
      }
    };
    self.postMessage(createReadyMessage("process", { watchdogFixture: true }));
  }
  // A run request is deliberately left unanswered. The host watchdog must
  // terminate both runtime workers and allow a fresh boot.
});
