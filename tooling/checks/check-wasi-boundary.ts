import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const boundary = JSON.parse(fs.readFileSync("compat/wasi-runtime-boundary.json", "utf8"));
const source = fs.readFileSync("packages/node-runtime/src/wasm-adapters/wasi-boundary.ts", "utf8");
const test = fs.readFileSync("packages/node-runtime/test/wasi-boundary.test.ts", "utf8");

assert(boundary.schemaVersion === 1, "unexpected WASI boundary schema");
assert(boundary.filesystem.readOutsideProject === "deny", "WASI reads outside project must be denied");
assert(boundary.filesystem.writeOutsideProject === "deny", "WASI writes outside project must be denied");
assert(boundary.filesystem.errorCode === "EWASIPATH", "unexpected WASI path error code");
assert(boundary.environment.deniedKeysErrorCode === "EWASIENV", "unexpected WASI env error code");
assert(boundary.stdio.defaultCapacityBytes >= 1048576, "default stdio capacity must be at least 1MiB");
assert(boundary.capabilities.directTcp === "deny", "direct TCP must be denied");
assert(boundary.capabilities.directUdp === "deny", "direct UDP must be denied");
assert(boundary.capabilities.fetch === "deny-unless-explicit-host-adapter", "fetch must require explicit adapter");
for (const token of ["validateWasiFilesystemAccess", "validateWasiNetwork", "filterWasiEnv", "createWasiStdioLimits"]) {
  assert(source.includes(token), `WASI boundary source missing ${token}`);
  assert(test.includes(token), `WASI boundary test missing ${token}`);
}

console.log("wasi boundary policy ok");
