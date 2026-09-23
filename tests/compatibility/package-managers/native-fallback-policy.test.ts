import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createNativeFallbackPolicy,
  createPackageExecutionPolicy,
  createPackageScriptRunner,
  createWasmAdapterPolicy,
  inferPackageName,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";

const root = new URL("../../..", import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "vendor/manifests/wasm-adapters.json"), "utf8"));
const nativeFallbackPolicy = createNativeFallbackPolicy({
  wasmPolicy: createWasmAdapterPolicy(manifest),
  browserPolyfills: {
    fsevents: "browser-empty-fsevents"
  }
});

assert.equal(inferPackageName("/workspace/node_modules/@esbuild/darwin-arm64/install.js"), "@esbuild/darwin-arm64");
assert.equal(inferPackageName("/workspace/packages/native/install.js"), "native");

assert.equal(
  nativeFallbackPolicy.classify({
    path: "/workspace/node_modules/@esbuild/darwin-arm64/install.js",
    command: "node install.js",
    source: "require('./bin/esbuild.node')"
  }).action,
  "use-wasm"
);
assert.equal(
  nativeFallbackPolicy.classify({
    path: "/workspace/node_modules/fsevents/install.js",
    command: "node-gyp rebuild",
    source: ""
  }).action,
  "browser-polyfill"
);
assert.equal(
  nativeFallbackPolicy.classify({
    path: "/workspace/node_modules/lightningcss-darwin-arm64/install.js",
    command: "prebuild-install",
    source: ""
  }).action,
  "unsupported"
);

const workspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/package.json",
    data: JSON.stringify({
      scripts: {
        esbuild: "node node_modules/@esbuild/darwin-arm64/install.js",
        fsevents: "node node_modules/fsevents/install.js",
        lightningcss: "node node_modules/lightningcss-darwin-arm64/install.js"
      }
    })
  },
  {
    path: "/workspace/node_modules/@esbuild/darwin-arm64/install.js",
    data: "require('./bin/esbuild.node')"
  },
  {
    path: "/workspace/node_modules/fsevents/install.js",
    data: "require('node-gyp')"
  },
  {
    path: "/workspace/node_modules/lightningcss-darwin-arm64/install.js",
    data: "require('./lightningcss.node')"
  }
]);
const runner = createPackageScriptRunner({
  cwd: "/workspace",
  reader: workspace,
  writer: workspace,
  policy: createPackageExecutionPolicy({ nativeFallbackPolicy })
});

const esbuild = runner.runScript("esbuild");
assert.equal(esbuild.exitCode, 1);
assert.equal(esbuild.error?.code, undefined);
assert.match(esbuild.stderr, /unsupported node script/);
const fsevents = runner.runScript("fsevents");
assert.equal(fsevents.exitCode, 1);
assert.equal(fsevents.error?.code, undefined);
assert.match(fsevents.stderr, /unsupported node script/);
const unsupported = runner.runScript("lightningcss");
assert.equal(unsupported.exitCode, 1);
assert.equal(unsupported.error.code, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");
assert.match(unsupported.stderr, /without a proven WASM adapter or browser polyfill/);

console.log("package manager native fallback policy test ok");
