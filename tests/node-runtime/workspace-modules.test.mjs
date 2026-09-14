import assert from "node:assert/strict";

import { createBuiltinLoader, createWorkspaceModuleRuntime, MemoryPackageManagerWorkspace } from "../../packages/node-runtime/src/index.ts";

const workspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/app.cjs",
    data: `
      const path = require("node:path");
      const plain = require("plain-pkg");
      const feature = require("plain-pkg/feature");
      const scoped = require("@scope/tool");
      const config = require("./config.json");
      module.exports = {
        base: path.basename(__filename),
        plain: plain.label,
        feature: feature.label,
        scoped: scoped.label,
        config
      };
    `
  },
  {
    path: "/workspace/config.json",
    data: JSON.stringify({ mode: "browser-runtime" })
  },
  {
    path: "/workspace/node_modules/plain-pkg/package.json",
    data: JSON.stringify({ name: "plain-pkg", main: "main.js" })
  },
  {
    path: "/workspace/node_modules/plain-pkg/main.js",
    data: "exports.label = 'plain-main';"
  },
  {
    path: "/workspace/node_modules/plain-pkg/feature.js",
    data: "exports.label = 'plain-feature';"
  },
  {
    path: "/workspace/node_modules/@scope/tool/package.json",
    data: JSON.stringify({ name: "@scope/tool", exports: "./index.cjs" })
  },
  {
    path: "/workspace/node_modules/@scope/tool/index.cjs",
    data: "module.exports = { label: 'scoped-tool' };"
  }
]);

const runtime = createWorkspaceModuleRuntime({
  root: "/workspace",
  reader: workspace,
  builtins: createBuiltinLoader({})
});

assert.deepEqual(runtime.requireSync("./app.cjs", "/workspace/index.cjs"), {
  base: "app.cjs",
  plain: "plain-main",
  feature: "plain-feature",
  scoped: "scoped-tool",
  config: {
    mode: "browser-runtime"
  }
});

assert.equal(runtime.resolve("plain-pkg", "/workspace/app.cjs"), "/workspace/node_modules/plain-pkg/main.js");
assert.equal(runtime.resolve("plain-pkg/feature", "/workspace/app.cjs"), "/workspace/node_modules/plain-pkg/feature.js");

console.log("node workspace modules test ok");
