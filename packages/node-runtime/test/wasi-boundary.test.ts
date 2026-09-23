import assert from "node:assert/strict";

import {
  createWasiRuntimeBoundary,
  createWasiStdioLimits,
  filterWasiEnv,
  validateWasiEnv,
  validateWasiFilesystemAccess,
  validateWasiNetwork
} from "../../node-runtime/src/index.ts";

const boundary = createWasiRuntimeBoundary({
  projectRoot: "/workspace/project",
  allowedEnv: ["NODE_ENV"],
  allowedEnvPrefixes: ["VITE_"],
  stdioCapacity: 4096
});

assert.equal(validateWasiFilesystemAccess(boundary, "/workspace/project/src/index.ts", "read"), "/workspace/project/src/index.ts");
assert.equal(validateWasiFilesystemAccess(boundary, "/workspace/project/dist/app.js", "write"), "/workspace/project/dist/app.js");

assert.throws(
  () => validateWasiFilesystemAccess(boundary, "/workspace/project/../secrets.env", "read"),
  (error) => error.code === "EWASIPATH"
);
assert.throws(
  () => validateWasiFilesystemAccess(boundary, "relative/path", "read"),
  (error) => error.code === "EWASIPATH"
);

assert.deepEqual(filterWasiEnv(boundary, {
  NODE_ENV: "development",
  VITE_PORT: "5173",
  SECRET_TOKEN: "nope"
}), {
  NODE_ENV: "development",
  VITE_PORT: "5173"
});
assert.throws(
  () => validateWasiEnv(boundary, { NODE_ENV: "development", SECRET_TOKEN: "nope" }),
  (error) => error.code === "EWASIENV"
);

assert.throws(
  () => validateWasiNetwork(boundary, "tcp"),
  (error) => error.code === "EWASINETWORK"
);
assert.throws(
  () => validateWasiNetwork(boundary, "udp"),
  (error) => error.code === "EWASINETWORK"
);
assert.throws(
  () => validateWasiNetwork(boundary, "fetch"),
  (error) => error.code === "EWASINETWORK"
);
validateWasiNetwork(createWasiRuntimeBoundary({ allowFetch: true }), "fetch");

assert.deepEqual(createWasiStdioLimits(boundary), {
  stdinBytes: 4096,
  stdoutBytes: 4096,
  stderrBytes: 4096
});
assert.throws(
  () => createWasiStdioLimits(createWasiRuntimeBoundary({ stdioCapacity: 0 })),
  (error) => error.code === "EWASISTDIO"
);

console.log("node runtime wasi boundary test ok");
