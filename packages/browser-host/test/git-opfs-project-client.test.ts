import assert from "node:assert/strict";

import { createGitOpfsProjectClient } from "../../browser-host/src/index.ts";

class FakeWorker {
  listeners = { message: new Set(), error: new Set() };
  messages = [];
  terminated = false;

  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => {
      for (const listener of this.listeners.message) listener({ data: { id: message.id, ok: true, stdout: `${message.action}\n` } });
    });
  }

  addEventListener(type, listener) { this.listeners[type].add(listener); }
  removeEventListener(type, listener) { this.listeners[type].delete(listener); }
  terminate() { this.terminated = true; }
}

const worker = new FakeWorker();
const client = createGitOpfsProjectClient({ projectId: "project-a", createWorker: () => worker, timeoutMs: 100, maxFileBytes: 16 });
await client.init();
await client.writeFile("src/main.ts", "export {}\n");
await client.add("src/main.ts");
await client.commit("initial", { name: "Fixture", email: "fixture@example.test" });
await client.log(1);
assert.ok(worker.messages.every((message) => message.projectId === "project-a"));
assert.throws(() => client.writeFile("../secret", "x"), { code: "EGITPROJECTPATH" });
assert.throws(() => client.writeFile(".git/config", "x"), { code: "EGITMETADATA" });
assert.throws(() => client.writeFile("large.txt", "x".repeat(17)), { code: "EGITFILELIMIT" });
for (const method of ["fetch", "clone"] as const) {
  const secret = "https://token:secret@example.test/repo.git";
  assert.throws(() => client[method](secret), (error: Error & { code?: string }) => error.code === "EGITNETWORK" && !error.message.includes("secret"));
}
client.close();
assert.equal(worker.terminated, true);
await assert.rejects(client.status(), { code: "EGITCLOSED" });
assert.throws(() => createGitOpfsProjectClient({ projectId: "../escape", createWorker: () => new FakeWorker() }), { code: "EGITPROJECT" });

console.log("Git OPFS project client test ok");
