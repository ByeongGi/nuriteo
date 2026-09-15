import assert from "node:assert/strict";

import { runViteReactProductWorkflow, ViteReactProductWorkflow } from "../../packages/node-runtime/src/index.ts";
import { createHmrClient, createPreviewRelay, createPreviewSessionRegistry } from "../../packages/preview/src/index.ts";

for (const manager of ["npm", "pnpm"]) {
  const result = runViteReactProductWorkflow({ manager });

  assert.equal(result.runtime, "browser-guest-node-runtime");
  assert.equal(result.manager, manager);
  assert.equal(result.install.installed, true);
  assert.equal(result.install.packages.includes("vite"), true);
  assert.equal(result.install.packages.includes("react"), true);
  assert.equal(result.devServer.running, true);
  assert.equal(result.preview.statusCode, 200);
  assert.match(result.preview.body, /alpha:1/);
  assert.match(result.hmr.before, /alpha:1/);
  assert.match(result.hmr.after, /beta:1/);
  assert.equal(result.hmr.statePreserved, true);
  assert.equal(result.build.files.includes("dist/index.html"), true);
  assert.match(result.build.distSmoke, /beta:1/);
  assert.equal(result.reloadRecovery.restarted, true);
  assert.match(result.reloadRecovery.previewAfterRestart, /beta:1/);

  const workflow = new ViteReactProductWorkflow({ manager, projectId: `${manager}-preview` });
  workflow.install();
  workflow.startDevServer();
  const sessions = createPreviewSessionRegistry({ ttlMs: 1000 });
  const session = sessions.create({
    origin: "https://preview.local",
    projectId: `${manager}-preview`,
    port: 5173,
    container: workflow
  });
  const relay = createPreviewRelay({ sessions, timeoutMs: 100 });
  const response = await relay.request({
    sessionId: session.sessionId,
    origin: "https://preview.local",
    projectId: `${manager}-preview`,
    path: "/index.html"
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /alpha:1/);

  const hmrEvents = [];
  const hmr = createHmrClient({
    connect() {
      return {
        sendMessage(payload) {
          this.onmessage?.({ data: JSON.stringify(payload) });
        },
        close() {
          this.onclose?.();
        }
      };
    }
  });
  hmr.on("open", (event) => hmrEvents.push(`open:${event.attempt}`));
  hmr.on("message", (event) => hmrEvents.push(`message:${event.type}`));
  hmr.start();
  hmr.socket.sendMessage({ type: "update", path: "/src/message.js" });
  hmr.close();
  assert.deepEqual(hmrEvents, ["open:1", "message:update"]);
}

console.log("vite react product workflow test ok");
