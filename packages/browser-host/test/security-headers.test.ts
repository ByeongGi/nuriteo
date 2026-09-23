import assert from "node:assert/strict";

import {
  createRuntimeHeaderSet,
  REQUIRED_RUNTIME_HEADERS,
  validateRuntimeHeaders
} from "../../browser-host/src/index.ts";

const headers = createRuntimeHeaderSet();
assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin");
assert.equal(headers["Cross-Origin-Embedder-Policy"], "require-corp");
assert.match(headers["Content-Security-Policy"], /worker-src 'self'/);

const document = validateRuntimeHeaders({
  url: "https://app.example/",
  headers
});
assert.equal(document.status, "pass");
assert.deepEqual(document.issues, []);

const wasm = validateRuntimeHeaders({
  url: "https://app.example/sdk/assets/system_wasm.wasm",
  kind: "wasm",
  headers: {
    ...headers,
    "Content-Type": "application/wasm"
  }
});
assert.equal(wasm.status, "pass");

const drifted = validateRuntimeHeaders({
  url: "https://app.example/",
  headers: {
    "Cross-Origin-Opener-Policy": "unsafe-none",
    "Content-Security-Policy": "default-src 'self'"
  }
});
assert.equal(drifted.status, "fail");
assert.deepEqual(
  drifted.issues.map((issue) => issue.header),
  ["cross-origin-opener-policy", "cross-origin-embedder-policy", "content-security-policy"]
);
assert.match(drifted.issues[0].message, /header drift/);

const wrongMime = validateRuntimeHeaders({
  url: "https://app.example/sdk/assets/system_wasm.wasm",
  kind: "wasm",
  headers: {
    ...headers,
    "Content-Type": "application/octet-stream"
  }
});
assert.equal(wrongMime.status, "fail");
assert.equal(wrongMime.issues.at(-1).expected, REQUIRED_RUNTIME_HEADERS.wasmMime);

console.log("browser host security headers test ok");
