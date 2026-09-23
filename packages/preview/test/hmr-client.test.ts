import assert from "node:assert/strict";

import { createHmrClient } from "../../preview/src/index.ts";

const sockets = [];
const events = [];
const hmr = createHmrClient({
  reconnectDelayMs: 0,
  maxRetries: 2,
  connect() {
    const socket = {
      close() {
        this.onclose?.();
      },
      sendMessage(payload) {
        this.onmessage?.({ data: JSON.stringify(payload) });
      }
    };
    sockets.push(socket);
    return socket;
  }
});
hmr.on("open", (event) => events.push(`open:${event.attempt}`));
hmr.on("close", () => events.push("close"));
hmr.on("message", (event) => events.push(`message:${event.type}`));
hmr.on("error", (event) => events.push(`error:${event.code}`));
hmr.on("reconnect", (event) => events.push(`reconnect:${event.attempt}`));

assert.equal(hmr.snapshot().state, "idle");
hmr.start();
assert.equal(hmr.snapshot().state, "connected");
sockets[0].sendMessage({ type: "connected" });
sockets[0].onmessage({ data: "{" });
assert.equal(hmr.snapshot().state, "error");
assert.equal(hmr.snapshot().lastError.code, "EBADMESSAGE");
sockets[0].close();
assert.equal(hmr.snapshot().state, "reconnecting");
await new Promise((resolve) => setTimeout(resolve, 0));
sockets[1].sendMessage({ type: "update" });
sockets[1].close();
await new Promise((resolve) => setTimeout(resolve, 0));
sockets[2].close();
await new Promise((resolve) => setTimeout(resolve, 0));

assert.deepEqual(events, [
  "open:1",
  "message:connected",
  "error:EBADMESSAGE",
  "close",
  "reconnect:2",
  "open:2",
  "message:update",
  "close",
  "reconnect:3",
  "open:3",
  "close"
]);
hmr.close();
assert.equal(hmr.snapshot().state, "closed");

console.log("preview hmr client test ok");
