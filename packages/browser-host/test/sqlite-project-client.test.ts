import assert from "node:assert/strict";

import { createSqliteProjectClient } from "../../browser-host/src/index.ts";

class FakeWorker {
  listeners = { message: new Set(), error: new Set() };
  messages = [];
  terminated = false;

  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => {
      const response = {
        id: message.id,
        ok: true,
        rows: message.values || ["persisted"],
        databasePath: `/nuriteo-${message.projectId}-${message.database}.sqlite3`,
        sqliteVersion: "3.53.4"
      };
      for (const listener of this.listeners.message) listener({ data: response });
    });
  }

  addEventListener(type, listener) { this.listeners[type].add(listener); }
  removeEventListener(type, listener) { this.listeners[type].delete(listener); }
  terminate() { this.terminated = true; }
}

const worker = new FakeWorker();
const client = createSqliteProjectClient({
  projectId: "project-a",
  database: "app",
  createWorker: () => worker,
  timeoutMs: 100
});
const write = await client.replaceValues(["committed"]);
assert.deepEqual(write.rows, ["committed"]);
assert.equal(write.databasePath, "/nuriteo-project-a-app.sqlite3");
const read = await client.readValues();
assert.deepEqual(read.rows, ["persisted"]);
assert.ok(worker.messages.every((message) => message.projectId === "project-a" && message.database === "app"));
client.close();
assert.equal(worker.terminated, true);
await assert.rejects(client.readValues(), { code: "ESQLITECLOSED" });
assert.throws(() => createSqliteProjectClient({ projectId: "../escape", createWorker: () => new FakeWorker() }), { code: "ESQLITEPROJECT" });

console.log("sqlite project client test ok");
