import assert from "node:assert/strict";

import {
  AbuseLimitError,
  checkAbuse,
  createAbuseLimitPolicy,
  createLifecyclePermissionDiagnostic,
  createPermissionManager,
  createRegistryCredentialStore,
  createRuntimeHeaderSet,
  createRuntimeSupportBundle,
  DEFAULT_ABUSE_LIMIT_POLICY,
  findPermissionCatalogEntry,
  HostProcessTable,
  importProjectZip,
  listPermissionCatalog,
  permissionRequestFromCatalog,
  redactRuntimeLog,
  redactSecrets,
  validateRuntimeHeaders
} from "../../browser-host/src/index.ts";
import { createPreviewReliabilitySession } from "../../preview-service/src/reliability.ts";
import {
  createPreviewRelay,
  createPreviewSessionRegistry
} from "../../preview/src/index.ts";

const policy = createAbuseLimitPolicy({
  maxWorkerSpawn: 2,
  maxArchiveBytes: 1024,
  maxLoopIterations: 10,
  maxMemoryGrowthBytes: 2048
});

const workerDeny = checkAbuse({ kind: "worker-spawn", workerSpawnCount: 3, projectId: "project-a" }, policy);
assert.equal(workerDeny.decision, "deny");
assert.equal(workerDeny.diagnostic.code, "ERR_ABUSE_WORKER_SPAWN");
assert.equal(workerDeny.diagnostic.projectId, "project-a");
assert.equal(workerDeny.diagnostic.observed, 3);
assert.equal(workerDeny.diagnostic.limit, 2);

const archiveDeny = checkAbuse({ kind: "archive", archiveBytes: 2048 }, policy);
assert.equal(archiveDeny.decision, "deny");
assert.equal(archiveDeny.diagnostic.code, "ERR_ABUSE_ARCHIVE_SIZE");

const loopDeny = checkAbuse({ kind: "loop", loopIterations: 11 }, policy);
assert.equal(loopDeny.decision, "deny");
assert.equal(loopDeny.diagnostic.code, "ERR_ABUSE_LOOP_ITERATIONS");

const memoryDeny = checkAbuse({ kind: "memory-growth", memoryGrowthBytes: 4096 }, policy);
assert.equal(memoryDeny.decision, "deny");
assert.equal(memoryDeny.diagnostic.code, "ERR_ABUSE_MEMORY_GROWTH");

const workerAllow = checkAbuse({ kind: "worker-spawn", workerSpawnCount: DEFAULT_ABUSE_LIMIT_POLICY.maxWorkerSpawn });
assert.equal(workerAllow.decision, "allow");
assert.equal(workerAllow.diagnostic, null);

const lifecycleEntry = findPermissionCatalogEntry("lifecycle", "run");
assert.equal(lifecycleEntry?.diagnosticCode, "ERR_PM_LIFECYCLE_BLOCKED");
assert.equal(lifecycleEntry?.promptRequired, true);
assert.ok(listPermissionCatalog("network").some((entry) => entry.action === "fetch"));

const lifecycleDiagnostic = createLifecyclePermissionDiagnostic({
  command: "node scripts/install.js",
  path: "/workspace/packages/tool"
});
assert.equal(lifecycleDiagnostic.code, "ERR_PM_LIFECYCLE_BLOCKED");
assert.equal(lifecycleDiagnostic.catalogId, "lifecycle-script-run");
assert.match(lifecycleDiagnostic.message, /node scripts\/install\.js/);

const permissions = createPermissionManager({
  rules: [{ scope: "network", action: "fetch", resourcePrefix: "https://registry.npmjs.org/", decision: "allow" }],
  defaultDecision: "deny"
});
assert.equal(
  permissions.check(
    permissionRequestFromCatalog(findPermissionCatalogEntry("network", "fetch"), "https://registry.npmjs.org/react", {
      projectId: "project-a"
    })
  ),
  "allow"
);
assert.equal(permissions.entries("network").at(-1).status, "allowed");
assert.equal(
  permissions.check(
    permissionRequestFromCatalog(findPermissionCatalogEntry("network", "fetch"), "https://evil.example/pkg", {
      projectId: "project-a"
    })
  ),
  "deny"
);
assert.equal(permissions.entries("network").at(-1).status, "denied");

const store = createRegistryCredentialStore();
store.setToken({
  registryOrigin: "https://registry.npmjs.org",
  scope: "@acme",
  token: "npm_beta_secret_token"
});
assert.equal(store.authorizationFor("https://registry.npmjs.org/@acme/pkg", "@acme"), "Bearer npm_beta_secret_token");
assert.equal(JSON.stringify(store.snapshot()).includes("npm_beta_secret_token"), false);
assert.equal(redactSecrets("auth=npm_beta_secret_token", ["npm_beta_secret_token"]), "auth=[REDACTED]");

const headers = createRuntimeHeaderSet();
const headerValidation = validateRuntimeHeaders({ url: "https://app.example/", headers });
assert.equal(headerValidation.status, "pass");
assert.deepEqual(headerValidation.issues, []);

const drifted = validateRuntimeHeaders({
  url: "https://app.example/",
  headers: {
    "Cross-Origin-Opener-Policy": "unsafe-none"
  }
});
assert.equal(drifted.status, "fail");
assert.ok(drifted.issues.some((issue) => issue.header === "cross-origin-embedder-policy"));

assert.equal(
  redactRuntimeLog("Cookie: sid=super-secret; theme=dark"),
  "Cookie: [REDACTED]"
);
assert.equal(redactRuntimeLog("cookie=session=abc123"), "cookie=[REDACTED]");
assert.match(redactRuntimeLog("_auth=registry-basic-auth"), /_auth=\[REDACTED\]/);

const bundle = createRuntimeSupportBundle({
  createdAt: "2026-09-18T00:00:00.000Z",
  logs: [
    "Authorization=Bearer npm_beta_secret_token",
    "Cookie: sid=super-secret",
    "cookie=session=abc123",
    "_auth=registry-basic-auth",
    "npm-auth-token=npm_beta_secret_token"
  ],
  environment: {
    browser: "Chrome",
    NPM_TOKEN: "npm_beta_secret_token",
    COOKIE: "sid=super-secret",
    registryAuth: "Bearer npm_beta_secret_token",
    safeFlag: true
  },
  diagnostics: [lifecycleDiagnostic]
});

const serialized = JSON.stringify(bundle);
assert.equal(serialized.includes("npm_beta_secret_token"), false);
assert.equal(serialized.includes("super-secret"), false);
assert.equal(serialized.includes("registry-basic-auth"), false);
assert.equal(bundle.environment.NPM_TOKEN, "[REDACTED]");
assert.equal(bundle.environment.COOKIE, "[REDACTED]");
assert.equal(bundle.environment.registryAuth, "[REDACTED]");
assert.equal(bundle.environment.safeFlag, true);
assert.equal(bundle.environment.browser, "Chrome");
assert.equal(bundle.diagnostics.at(-1).code, "ERR_PM_LIFECYCLE_BLOCKED");
assert.match(bundle.logs.join("\n"), /Cookie: \[REDACTED\]/);
assert.match(bundle.logs.join("\n"), /cookie=\[REDACTED\]/);

const sessions = createPreviewSessionRegistry();
const session = sessions.create({
  origin: "https://preview.local",
  projectId: "project-a",
  port: 5173,
  container: {
    fetch: async () => new Response("ok", { status: 200 })
  }
});
const relay = createPreviewRelay({ sessions });
await assert.rejects(
  relay.request({
    sessionId: session.sessionId,
    origin: "https://evil.example",
    projectId: "project-a",
    path: "/"
  }),
  (error) => error.code === "ESTALESESSION"
);
assert.equal(sessions.get(session.sessionId, { origin: "https://preview.local", projectId: "project-a" })?.sessionId, session.sessionId);

// Product call sites: zip import and worker spawn must deny without crashing the service.
const oversizedArchive = new Uint8Array(policy.maxArchiveBytes + 1);
const zipDenied = importProjectZip(oversizedArchive, {
  abusePolicy: policy,
  projectId: "project-a"
});
assert.equal(zipDenied.files.length, 0);
assert.equal(zipDenied.diagnostics[0]?.code, "ERR_ABUSE_ARCHIVE_SIZE");
assert.match(zipDenied.diagnostics[0]?.message || "", /exceeded abuse limit/);

function createReadyWorker() {
  const listeners = { message: new Set(), error: new Set() };
  return {
    addEventListener(type, listener) {
      listeners[type]?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners[type]?.delete(listener);
    },
    postMessage(message) {
      if (message?.type === "start") {
        queueMicrotask(() => {
          for (const listener of listeners.message) {
            listener({ data: { type: "ready" } });
          }
        });
      }
    },
    terminate() {}
  };
}

const table = new HostProcessTable({
  abusePolicy: createAbuseLimitPolicy({ maxWorkerSpawn: 2 }),
  workerFactory: () => createReadyWorker()
});
// Real prepare sequence: five prepares must not all succeed when maxWorkerSpawn=2.
const first = table.prepare({ url: "https://example.invalid/worker-a.js", projectId: "project-a" });
const second = table.prepare({ url: "https://example.invalid/worker-b.js", projectId: "project-a" });
assert.equal(table.records.size, 2);
for (let i = 0; i < 3; i += 1) {
  assert.throws(
    () => table.prepare({ url: `https://example.invalid/worker-extra-${i}.js`, projectId: "project-a" }),
    (error) => error instanceof AbuseLimitError && error.code === "ERR_ABUSE_WORKER_SPAWN"
  );
}
assert.equal(table.records.size, 2, "over-limit prepare must not leave extra process records");
assert.equal(table.registry.size(), 0, "prepare alone must not register workers");

await table.start(first.pid);
assert.equal(table.registry.size(), 1);
await table.start(second.pid);
assert.equal(table.registry.size(), 2);

// Free one active slot; another prepare may succeed, but a further prepare must still deny.
table.stop(first.pid);
assert.equal(table.registry.size(), 1);
const third = table.prepare({ url: "https://example.invalid/worker-c.js", projectId: "project-a" });
assert.equal(table.records.size, 3);
assert.throws(
  () => table.prepare({ url: "https://example.invalid/worker-d.js", projectId: "project-a" }),
  (error) => error instanceof AbuseLimitError && error.code === "ERR_ABUSE_WORKER_SPAWN"
);
assert.equal(table.records.size, 3, "denied prepare must not add a fourth record");
assert.ok(table.records.has(third.pid));
await table.start(third.pid);
assert.equal(table.registry.size(), 2);

const reliability = createPreviewReliabilitySession({
  abusePolicy: {
    maxMemoryGrowthBytes: 2048
  },
  policy: {
    storage: {
      quotaBytesDefault: 128,
      evictionPrefixes: ["cache/"],
      protectedPrefixes: ["projects/"],
      writerLeaseTtlMs: 30_000
    }
  }
});
assert.throws(
  () => reliability.guardLoopIterations(1_000_001),
  (error) => error instanceof AbuseLimitError && error.code === "ERR_ABUSE_LOOP_ITERATIONS"
);
assert.throws(
  () => reliability.guardMemoryGrowth(4096),
  (error) => error instanceof AbuseLimitError && error.code === "ERR_ABUSE_MEMORY_GROWTH"
);

console.log("browser host security beta test ok");
