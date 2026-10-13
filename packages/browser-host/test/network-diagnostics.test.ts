import assert from "node:assert/strict";

import {
  createRuntimeNetworkRecoveryDiagnostic,
  createRuntimeNetworkUnsupportedDiagnostic
} from "../../browser-host/src/index.ts";

const tcpDb = createRuntimeNetworkUnsupportedDiagnostic({
  error: {
    code: "ERR_BROWSER_TCP_UNSUPPORTED",
    message: "Direct TCP sockets are not available in the browser runtime"
  },
  host: "database.local",
  port: 5432,
  requestId: "db-1"
});
assert.equal(tcpDb.code, "ERR_RUNTIME_TCP_DB_UNSUPPORTED");
assert.equal(tcpDb.source, "network");
assert.equal(tcpDb.requestId, "db-1");
assert.match(tcpDb.message, /Direct TCP database access is unsupported/);
assert.match(tcpDb.remediation, /HTTP adapter/);

const postgresUrl = createRuntimeNetworkUnsupportedDiagnostic({
  url: "postgres://localhost:5432/app"
});
assert.equal(postgresUrl.code, "ERR_RUNTIME_TCP_DB_UNSUPPORTED");

const recovery = createRuntimeNetworkRecoveryDiagnostic({
  error: {
    code: "ERR_BROWSER_TCP_UNSUPPORTED",
    message: "socket rejected"
  },
  host: "redis.local",
  port: 6379
}, ["connect redis"]);
assert.equal(recovery.recovery.blocked, true);
assert.deepEqual(recovery.recovery.actions.map((action) => action.kind), ["open-docs", "export-support-bundle"]);
assert.match(recovery.supportBundle.logs.join("\n"), /connect redis/);

assert.equal(
  createRuntimeNetworkUnsupportedDiagnostic({
    error: { code: "ERR_BROWSER_TCP_UNSUPPORTED", message: "socket rejected" },
    host: "api.local",
    port: 443
  }),
  null
);

console.log("browser host network diagnostics test ok");
