import assert from "node:assert/strict";
import { createPreviewSessionRegistry, createPreviewRelay, PreviewRelayError } from "../../packages/preview/src/index.ts";

let now = 1_000;
const sessions = createPreviewSessionRegistry({ now: () => now, ttlMs: 1_000 });
const relay = createPreviewRelay({ sessions, timeoutMs: 500 });

const first = sessions.create({
  origin: "http://127.0.0.1:5180",
  projectId: "preview-service",
  port: 5173,
  container: {
    fetch: async () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } })
  }
});

const ok = await relay.request({
  sessionId: first.sessionId,
  origin: first.origin,
  projectId: first.projectId,
  path: "/"
});
assert.equal(ok.status, 200);

now += 5_000;
await assert.rejects(
  () => relay.request({
    sessionId: first.sessionId,
    origin: first.origin,
    projectId: first.projectId,
    path: "/"
  }),
  (error) => error instanceof PreviewRelayError && error.code === "ESTALESESSION"
);

// Rebind path used by controller: create a fresh session and serve again.
const rebound = sessions.create({
  origin: first.origin,
  projectId: first.projectId,
  port: 5173,
  container: {
    fetch: async () => new Response("<html>rebound</html>", { status: 200, headers: { "content-type": "text/html" } })
  }
});
const again = await relay.request({
  sessionId: rebound.sessionId,
  origin: rebound.origin,
  projectId: rebound.projectId,
  path: "/"
});
assert.equal(again.status, 200);
assert.equal(await again.text(), "<html>rebound</html>");

console.log("preview-service stale-session test ok");
