import assert from "node:assert/strict";

import {
  createVitePreviewErrorDiagnostic,
  originalPreviewPositionFor
} from "../../preview/src/index.ts";

const sourceMap = {
  mappings: "AAAA",
  sources: ["src/App.tsx"]
};

assert.deepEqual(originalPreviewPositionFor(sourceMap, 1, 1), {
  source: "src/App.tsx",
  line: 1,
  column: 1
});

const buildError = new Error("Unexpected token at /dist/assets/App.js:1:1");
buildError.stack = "Error: Unexpected token\n    at /dist/assets/App.js:1:1";
const diagnostic = createVitePreviewErrorDiagnostic({
  command: "pnpm run build",
  error: buildError,
  file: "/dist/assets/App.js",
  line: 1,
  column: 1,
  source: "build",
  sourceMap
}, 1234);

assert.equal(diagnostic.at, 1234);
assert.equal(diagnostic.code, "EVITEBUILD");
assert.equal(diagnostic.file, "src/App.tsx");
assert.equal(diagnostic.line, 1);
assert.equal(diagnostic.column, 1);
assert.equal(diagnostic.recoveryActions[0].kind, "open-file");
assert.equal(diagnostic.recoveryActions[0].path, "src/App.tsx");
assert.equal(diagnostic.recoveryActions[1].kind, "rerun-build");
assert.equal(diagnostic.recoveryActions[1].command, "pnpm run build");
assert.match(diagnostic.stack, /App\.js/);

const hmrDiagnostic = createVitePreviewErrorDiagnostic({
  error: "HMR update failed in /src/main.jsx:3:4",
  source: "hmr"
}, 1235);
assert.equal(hmrDiagnostic.code, "EVITEHMR");
assert.equal(hmrDiagnostic.file, "/src/main.jsx");
assert.equal(hmrDiagnostic.line, 3);
assert.equal(hmrDiagnostic.column, 4);
assert.equal(hmrDiagnostic.recoveryActions.at(-1).kind, "restart-dev-server");

const runtimeDiagnostic = createVitePreviewErrorDiagnostic({
  error: new Error("ReferenceError: missing"),
  source: "runtime"
}, 1236);
assert.equal(runtimeDiagnostic.code, "EVITERUNTIME");
assert.equal(runtimeDiagnostic.recoveryActions.at(-1).kind, "show-terminal");

console.log("preview error overlay test ok");
