import assert from "node:assert/strict";

import { createRuntimeTraceCollector, HostFetcher, HostProcessTable } from "../../browser-host/src/index.ts";
import { createPackageExecutionPolicy, createPackageScriptRunner, MemoryPackageManagerWorkspace } from "../../node-runtime/src/index.ts";
import { createPreviewRelay, createPreviewSessionRegistry } from "../../preview/src/index.ts";

let now = 1000;
const trace = createRuntimeTraceCollector(() => now++);

const fetcher = new HostFetcher({
  trace,
  fetchImpl: async () => new Response("not found", { status: 404 })
});
await fetcher.download("https://registry.npmjs.org/missing", { projectId: "project-a" });

const processes = new HostProcessTable({ trace });
const prepared = processes.prepare({ projectId: "project-a", url: "worker://runtime/process-worker.js" });
assert.equal(prepared.pid, 1);

const sessions = createPreviewSessionRegistry({ now: () => now++ });
const preview = createPreviewRelay({ sessions, trace });
await assert.rejects(
  preview.request({
    sessionId: "missing",
    origin: "https://preview.local",
    projectId: "project-a"
  }),
  (error) => error.code === "ESTALESESSION"
);

const workspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/package.json",
    data: JSON.stringify({
      scripts: {
        native: "node scripts/native.js"
      }
    })
  },
  {
    path: "/workspace/scripts/native.js",
    data: "require('./addon.node')\n"
  }
]);
const scripts = createPackageScriptRunner({
  cwd: "/workspace",
  reader: workspace,
  writer: workspace,
  trace,
  policy: createPackageExecutionPolicy()
});
assert.equal(scripts.runScript("native").error.code, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");

const spans = trace.export();
assert.deepEqual(
  spans.map((span) => `${span.category}:${span.name}:${span.status}:${span.errorCode || ""}`),
  [
    "network:host-fetch.download:error:",
    "process:host-process.prepare:ok:",
    "preview:preview-relay.request:error:ESTALESESSION",
    "package-manager:package-script.run:error:ERR_PM_NATIVE_ADDON_UNSUPPORTED"
  ]
);
assert.equal(spans[0].requestId, "project-a");
assert.equal(spans[2].requestId, "missing");
assert.equal(spans.every((span) => typeof span.durationMs === "number"), true);

trace.clear();
assert.deepEqual(trace.export(), []);

console.log("browser host tracing test ok");
