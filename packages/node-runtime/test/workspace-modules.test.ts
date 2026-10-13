import assert from "node:assert/strict";

import { createBuiltinLoader, createWorkspaceModuleRuntime, MemoryPackageManagerWorkspace } from "../../node-runtime/src/index.ts";

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
      const browserMain = require("browser-main-pkg");
      const parent = require("parent-pkg");
      const self = require("self-pkg/internal");
      const pattern = require("pattern-pkg/lib/tool");
      const esmOnly = require("esm-only");
      const commentedExports = require("commented-exports");
      const regexLiteral = require("regex-literal");
      const config = require("./config.json");
      module.exports = {
        base: path.basename(__filename),
        plain: plain.label,
        feature: feature.label,
        scoped: scoped.label,
        conditional: conditional.label,
        conditionalFeature: conditionalFeature.label,
        browserMain: browserMain.label,
        parent,
        self: self.label,
        pattern: pattern.label,
        esmOnly: esmOnly.label,
        commentedExports: commentedExports.label,
        regexLiteral: regexLiteral.label,
        config
      };
    `
  },
  {
    path: "/workspace/config.json",
    data: JSON.stringify({ mode: "browser-runtime" })
  },
  {
    path: "/workspace/tsconfig.json",
    data: `// This file is JSONC in many real projects.
      {
        "compilerOptions": {
          "module": "esnext"
        }
      }
    `
  },
  {
    path: "/workspace/source-esm.mjs",
    data: `
      import path from "node:path";
      import { basename } from "node:path";
      export const base = basename("/workspace/source-esm.mjs");
      export const defaultBase = path.basename("/workspace/source-esm-default.mjs");
    `
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
    path: "/workspace/node_modules/browser-main-pkg/package.json",
    data: JSON.stringify({ name: "browser-main-pkg", main: "node.cjs", browser: "browser.js" })
  },
  {
    path: "/workspace/node_modules/browser-main-pkg/node.cjs",
    data: "exports.label = 'node-main';"
  },
  {
    path: "/workspace/node_modules/browser-main-pkg/browser.js",
    data: "exports.label = 'browser-main';"
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
  },
  {
    path: "/workspace/node_modules/esm-only/package.json",
    data: JSON.stringify({ name: "esm-only", type: "module", exports: "./index.js" })
  },
  {
    path: "/workspace/node_modules/esm-only/index.js",
    data: "import { suffix } from './suffix.js';\nexport const label = `esm-${suffix}`;\n"
  },
  {
    path: "/workspace/node_modules/esm-only/suffix.js",
    data: "export const suffix = 'required';\n"
  },
  {
    path: "/workspace/node_modules/commented-exports/package.json",
    data: JSON.stringify({ name: "commented-exports", type: "module", exports: "./index.js" })
  },
  {
    path: "/workspace/node_modules/commented-exports/index.js",
    data: "/*\nexport function phantom() {}\n*/\nexport const label = 'comments-ignored';\n"
  },
  {
    path: "/workspace/node_modules/regex-literal/package.json",
    data: JSON.stringify({ name: "regex-literal", type: "module", exports: "./index.js" })
  },
  {
    path: "/workspace/node_modules/regex-literal/index.js",
    data: "const blockCommentPattern = /\\/\\*[\\s\\S]*?\\*\\//g;\nexport const label = blockCommentPattern.test('/*x*/') ? 'regex-preserved' : 'broken';\n"
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
  browserMain: "browser-main",
  parent: "nested-shared",
  self: "self-reference",
  pattern: "pattern-export",
  esmOnly: "esm-required",
  commentedExports: "comments-ignored",
  regexLiteral: "regex-preserved",
  config: {
    mode: "browser-runtime"
  }
});

assert.equal(runtime.resolve("plain-pkg", "/workspace/app.cjs"), "/workspace/node_modules/plain-pkg/main.js");
assert.equal(runtime.resolve("plain-pkg/feature", "/workspace/app.cjs"), "/workspace/node_modules/plain-pkg/feature.js");
assert.equal(runtime.resolve("browser-main-pkg", "/workspace/app.cjs"), "/workspace/node_modules/browser-main-pkg/browser.js");
assert.equal(runtime.resolve("shared", "/workspace/node_modules/parent-pkg/index.js"), "/workspace/node_modules/parent-pkg/node_modules/shared/index.js");
assert.equal(runtime.resolve("self-pkg/internal", "/workspace/node_modules/self-pkg/index.js"), "/workspace/node_modules/self-pkg/internal.js");
assert.equal(runtime.resolve("pattern-pkg/lib/tool", "/workspace/app.cjs"), "/workspace/node_modules/pattern-pkg/src/lib/tool.cjs");

const sourceEsm = await runtime.importModule("./source-esm.mjs", "/workspace/index.mjs");
assert.equal(sourceEsm.base, "source-esm.mjs");
assert.equal(sourceEsm.defaultBase, "source-esm-default.mjs");

console.log("node workspace modules test ok");
