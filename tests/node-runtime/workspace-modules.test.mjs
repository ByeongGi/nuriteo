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
      const conditional = require("conditional-pkg");
      const conditionalFeature = require("conditional-pkg/feature");
      const parent = require("parent-pkg");
      const self = require("self-pkg/internal");
      const pattern = require("pattern-pkg/lib/tool");
      const config = require("./config.json");
      module.exports = {
        base: path.basename(__filename),
        plain: plain.label,
        feature: feature.label,
        scoped: scoped.label,
        conditional: conditional.label,
        conditionalFeature: conditionalFeature.label,
        parent,
        self: self.label,
        pattern: pattern.label,
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
  },
  {
    path: "/workspace/node_modules/conditional-pkg/package.json",
    data: JSON.stringify({
      name: "conditional-pkg",
      exports: {
        ".": {
          import: "./esm.mjs",
          require: "./cjs.cjs",
          default: "./default.js"
        },
        "./feature": {
          node: "./feature.cjs",
          default: "./feature-default.js"
        }
      }
    })
  },
  {
    path: "/workspace/node_modules/conditional-pkg/cjs.cjs",
    data: "exports.label = 'conditional-require';"
  },
  {
    path: "/workspace/node_modules/conditional-pkg/feature.cjs",
    data: "exports.label = 'conditional-node';"
  },
  {
    path: "/workspace/node_modules/shared/package.json",
    data: JSON.stringify({ name: "shared", main: "index.js" })
  },
  {
    path: "/workspace/node_modules/shared/index.js",
    data: "exports.label = 'root-shared';"
  },
  {
    path: "/workspace/node_modules/parent-pkg/package.json",
    data: JSON.stringify({ name: "parent-pkg", main: "index.js" })
  },
  {
    path: "/workspace/node_modules/parent-pkg/index.js",
    data: "module.exports = require('shared').label;"
  },
  {
    path: "/workspace/node_modules/parent-pkg/node_modules/shared/package.json",
    data: JSON.stringify({ name: "shared", main: "index.js" })
  },
  {
    path: "/workspace/node_modules/parent-pkg/node_modules/shared/index.js",
    data: "exports.label = 'nested-shared';"
  },
  {
    path: "/workspace/node_modules/self-pkg/package.json",
    data: JSON.stringify({
      name: "self-pkg",
      exports: {
        ".": "./index.js",
        "./internal": "./internal.js"
      }
    })
  },
  {
    path: "/workspace/node_modules/self-pkg/index.js",
    data: "module.exports = require('self-pkg/internal');"
  },
  {
    path: "/workspace/node_modules/self-pkg/internal.js",
    data: "exports.label = 'self-reference';"
  },
  {
    path: "/workspace/node_modules/pattern-pkg/package.json",
    data: JSON.stringify({
      name: "pattern-pkg",
      exports: {
        "./*": {
          require: "./src/*.cjs",
          default: "./src/*.js"
        }
      }
    })
  },
  {
    path: "/workspace/node_modules/pattern-pkg/src/lib/tool.cjs",
    data: "exports.label = 'pattern-export';"
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
  conditional: "conditional-require",
  conditionalFeature: "conditional-node",
  parent: "nested-shared",
  self: "self-reference",
  pattern: "pattern-export",
  config: {
    mode: "browser-runtime"
  }
});

assert.equal(runtime.resolve("plain-pkg", "/workspace/app.cjs"), "/workspace/node_modules/plain-pkg/main.js");
assert.equal(runtime.resolve("plain-pkg/feature", "/workspace/app.cjs"), "/workspace/node_modules/plain-pkg/feature.js");
assert.equal(runtime.resolve("shared", "/workspace/node_modules/parent-pkg/index.js"), "/workspace/node_modules/parent-pkg/node_modules/shared/index.js");
assert.equal(runtime.resolve("self-pkg/internal", "/workspace/node_modules/self-pkg/index.js"), "/workspace/node_modules/self-pkg/internal.js");
assert.equal(runtime.resolve("pattern-pkg/lib/tool", "/workspace/app.cjs"), "/workspace/node_modules/pattern-pkg/src/lib/tool.cjs");

console.log("node workspace modules test ok");
