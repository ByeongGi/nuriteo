import assert from "node:assert/strict";

import { createPermissionManager, HostFetcher, HostProcessTable } from "../../browser-host/src/index.ts";

let now = 1000;
const permissions = createPermissionManager({
  now: () => now,
  rules: [
    { scope: "network", action: "fetch", resourcePrefix: "https://registry.npmjs.org/", decision: "allow" },
    { scope: "network", action: "redirect", resourcePrefix: "https://registry.npmjs.org/", decision: "allow" },
    { scope: "process", action: "prepare", resourcePrefix: "worker://runtime/", decision: "allow" }
  ],
  defaultDecision: "deny"
});

const fetcher = new HostFetcher({
  permissions,
  fetchImpl: async (url) => new Response("ok", { status: 200, headers: { "x-url": url } })
});

const ok = await fetcher.download("https://registry.npmjs.org/react", { projectId: "project-a" });
assert.equal(ok.status, 200);
assert.equal(permissions.entries("network")[0].status, "allowed");
assert.equal(permissions.entries("network")[0].projectId, "project-a");

now += 1;
await assert.rejects(
  fetcher.download("https://example.com/react", { projectId: "project-a" }),
  (error) => {
    assert.equal(error.code, "EPERMISSION");
    assert.equal(error.request.scope, "network");
    assert.equal(error.request.action, "fetch");
    return true;
  }
);
assert.equal(permissions.entries("network").at(-1).status, "denied");

now += 1;
const redirectingFetcher = new HostFetcher({
  permissions,
  fetchImpl: async (url) => {
    if (url === "https://registry.npmjs.org/redirect") {
      return new Response(null, { status: 302, headers: { location: "https://evil.example/pkg.tgz" } });
    }
    return new Response("ok", { status: 200 });
  }
});
await assert.rejects(
  redirectingFetcher.download("https://registry.npmjs.org/redirect", { projectId: "project-a" }),
  (error) => error.code === "EPERMISSION" && error.request.action === "redirect"
);

now += 1;
const processes = new HostProcessTable({ permissions });
const prepared = processes.prepare({
  projectId: "project-a",
  url: "worker://runtime/process-worker.js"
});
assert.equal(prepared.projectId, "project-a");
assert.equal(permissions.entries("process").at(-1).status, "allowed");
assert.throws(
  () => processes.prepare({ projectId: "project-a", url: "https://evil.example/worker.js" }),
  (error) => error.code === "EPERMISSION" && error.request.scope === "process"
);
assert.equal(permissions.entries("process").at(-1).status, "denied");

assert.deepEqual(
  permissions.entries().map((entry) => `${entry.scope}:${entry.action}:${entry.status}`),
  [
    "network:fetch:allowed",
    "network:fetch:denied",
    "network:fetch:allowed",
    "network:redirect:denied",
    "process:prepare:allowed",
    "process:prepare:denied"
  ]
);

console.log("browser host permission model test ok");
