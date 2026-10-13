import assert from "node:assert/strict";

import { createBuiltinLoader } from "../../node-runtime/src/builtin-loader.ts";
import { BrowserBuffer } from "../../node-runtime/src/builtins/buffer.ts";
import { createModuleRuntime, createWorkspaceModuleRuntime } from "../../node-runtime/src/modules/index.ts";
import { prepareEsmStaticFactoryBody } from "../../node-runtime/src/modules/esm.ts";

const viteStaticFactoryBody = prepareEsmStaticFactoryBody(`
  const key = "MODE";
  const definitions = { "import.meta.url": "url", [\`import.meta.env.\${key}\`]: "mode" };
  const actualUrl = import.meta.url;
  const generated = \`literal import.meta.hot; runtime \${import.meta.url}\`;
  export { actualUrl, definitions, generated };
`, "/workspace/project/node_modules/vite/dist/node/probe.js");
assert.match(viteStaticFactoryBody, /"import\.meta\.url"/);
assert.match(viteStaticFactoryBody, /`import\.meta\.env\.\$\{key\}`/);
assert.match(viteStaticFactoryBody, /const actualUrl = __context\.importMeta\.url/);
assert.match(viteStaticFactoryBody, /runtime \$\{__context\.importMeta\.url\}/);
assert.doesNotThrow(() => new Function("__context", "__process", "__global", "__console", "__globalThis", viteStaticFactoryBody));

const runtime = createModuleRuntime({
  builtins: createBuiltinLoader({}),
  globals: {
    Buffer: BrowserBuffer,
    console: {
      log() {
        return undefined;
      }
    },
    global: {
      marker: "runtime-global"
    },
    process: {
      argv: ["node", "/workspace/index.cjs", "--fixture"]
    }
  },
  imports: {
    "#counter": "./live-binding.mjs"
  },
  packages: {
    "pkg-fixture": {
      root: "/workspace/node_modules/pkg-fixture",
      type: "module",
      exports: {
        ".": {
          import: "./main.mjs",
          require: "./require-main.cjs"
        },
        "./feature": {
          import: "./feature.mjs",
          require: "./feature.cjs"
        }
      },
      imports: {
        "#private": {
          import: "./private.mjs",
          require: "./private.cjs"
        }
      }
    },
    "browser-conditional": {
      root: "/workspace/node_modules/browser-conditional",
      exports: {
        ".": {
          browser: "./browser.mjs",
          import: "./node.mjs",
          require: "./node.cjs"
        }
      }
    }
  },
  realpaths: {
    "/workspace/linked.cjs": "/workspace/cjs-cycle-a.cjs"
  }
});

runtime.registerMany({
  "/workspace/cjs-cycle-a.cjs": {
    kind: "cjs",
    factory({ module, require }) {
      module.exports.name = "a";
      const b = require("./cjs-cycle-b.cjs");
      module.exports.fromB = b.name;
      module.exports.bSawA = b.fromA;
    }
  },
  "/workspace/cjs-cycle-b.cjs": {
    kind: "cjs",
    factory({ module, require }) {
      module.exports.name = "b";
      const a = require("./cjs-cycle-a.cjs");
      module.exports.fromA = a.name;
    }
  },
  "/workspace/live-binding.mjs": {
    kind: "esm",
    factory(ctx) {
      let count = 0;
      ctx.exportLive("count", () => count);
      ctx.exportConst("increment", () => {
        count += 1;
      });
    }
  },
  "/workspace/live-binding-consumer.mjs": {
    kind: "esm",
    imports: ["#counter"],
    factory(ctx) {
      const counter = ctx.importNamespace("#counter");
      counter.increment();
      ctx.exportConst("observed", counter.count);
      ctx.exportConst("afterIncrement", () => counter.count);
    }
  },
  "/workspace/cycle-a.mjs": {
    kind: "esm",
    imports: ["./cycle-b.mjs"],
    factory(ctx) {
      const b = ctx.importNamespace("./cycle-b.mjs");
      ctx.exportConst("valueA", "A");
      ctx.exportConst("fromB", () => b.valueB);
    }
  },
  "/workspace/cycle-b.mjs": {
    kind: "esm",
    imports: ["./cycle-a.mjs"],
    factory(ctx) {
      const a = ctx.importNamespace("./cycle-a.mjs");
      ctx.exportConst("valueB", "B");
      ctx.exportConst("fromA", () => a.valueA);
    }
  },
  "/workspace/tla-dynamic.mjs": {
    kind: "esm",
    async factory(ctx) {
      const loaded = await ctx.dynamicImport("./live-binding-consumer.mjs");
      ctx.exportConst("observed", loaded.observed);
      ctx.exportConst("afterIncrement", loaded.afterIncrement);
    }
  },
  "/workspace/cjs-target.cjs": {
    kind: "cjs",
    factory({ module }) {
      function label(value) {
        return `value:${value}`;
      }
      label.kind = "fixture";
      module.exports = label;
    }
  },
  "/workspace/cjs-dynamic-consumer.mjs": {
    kind: "esm",
    async factory(ctx) {
      const loaded = await ctx.dynamicImport("./cjs-target.cjs");
      ctx.exportConst("hasDefault", typeof loaded.default === "function");
      ctx.exportConst("namedStatic", loaded.kind);
      ctx.exportConst("rendered", loaded.default("ok"));
    }
  },
  "/workspace/source-live-binding.mjs": {
    kind: "esm-source",
    source: `
      export let count = 0;
      export function increment() {
        count += 1;
      }
    `
  },
  "/workspace/source-live-binding-consumer.mjs": {
    kind: "esm-source",
    source: `
      import * as counter from './source-live-binding.mjs';
      counter.increment();
      export const observed = counter.count;
    `
  },
  "/workspace/file url target.mjs": {
    kind: "esm-source",
    source: "export const label = 'file-url-target';\n"
  },
  "/workspace/source-default-function.mjs": {
    kind: "esm-source",
    source: `
      export default function label(value) {
        return 'label:' + value;
      }
    `
  },
  "/workspace/source-default-class.mjs": {
    kind: "esm-source",
    source: `
      export default class Factory {
        label() {
          return 'factory';
        }
      }
    `
  },
  "/workspace/source-default-declaration-consumer.mjs": {
    kind: "esm-source",
    source: `
      import label from './source-default-function.mjs';
      import Factory from './source-default-class.mjs';
      export const rendered = label('ok') + ':' + new Factory().label();
    `
  },
  "/workspace/source-multiline-default-call.mjs": {
    kind: "esm-source",
    source: `
      function defineConfig(value) {
        return value;
      }
      export default defineConfig({
        plugins: ['react'],
      })
    `
  },
  "/workspace/source-anonymous-default-function.mjs": {
    kind: "esm-source",
    source: `
      export default function (value) {
        return 'anonymous:' + value;
      }
    `
  },
  "/workspace/source-anonymous-default-class.mjs": {
    kind: "esm-source",
    source: `
      export default class {
        label() {
          return 'anonymous-factory';
        }
      }
    `
  },
  "/workspace/source-anonymous-default-consumer.mjs": {
    kind: "esm-source",
    source: `
      import label from './source-anonymous-default-function.mjs';
      import Factory from './source-anonymous-default-class.mjs';
      export const rendered = label('ok') + ':' + new Factory().label();
    `
  },
  "/workspace/source-default-namespace-import.mjs": {
    kind: "esm-source",
    source: `
      import label, * as labels from './source-default-function.mjs';
      export const rendered = label('ok') + ':' + labels.default('ns');
    `
  },
  "/workspace/source-multiline-named-import.mjs": {
    kind: "esm-source",
    source: `
      import {
        default as label,
      } from './source-default-function.mjs';
      export const rendered = label('multi');
    `
  },
  "/workspace/source-destructured-export.mjs": {
    kind: "esm-source",
    source: `
      const values = { fs: 'fs-export', vol: 'vol-export' };
      export const { fs: __fs, vol } = values;
    `
  },
  "/workspace/source-top-level-await.mjs": {
    kind: "esm-source",
    source: `
      const value = await Promise.resolve('async-source');
      export const label = value;
    `
  },
  "/workspace/source-top-level-await-require.mjs": {
    kind: "esm-source",
    source: `
      const value = await Promise.resolve('require-async-source');
      export const label = value;
    `
  },
  "/workspace/node_modules/pkg-fixture/main.mjs": {
    kind: "esm",
    factory(ctx) {
      ctx.exportConst("kind", "package-main");
      ctx.exportConst("resolved", ctx.importMeta.resolve("pkg-fixture/feature"));
    }
  },
  "/workspace/node_modules/pkg-fixture/require-main.cjs": {
    kind: "cjs",
    factory({ module }) {
      module.exports = { kind: "package-require-main" };
    }
  },
  "/workspace/node_modules/pkg-fixture/feature.cjs": {
    kind: "cjs",
    factory({ module }) {
      module.exports = { kind: "package-feature" };
    }
  },
  "/workspace/node_modules/pkg-fixture/feature.mjs": {
    kind: "esm",
    factory(ctx) {
      ctx.exportConst("kind", "package-import-feature");
    }
  },
  "/workspace/node_modules/pkg-fixture/private.cjs": {
    kind: "cjs",
    factory({ module }) {
      module.exports = { kind: "package-private-require" };
    }
  },
  "/workspace/node_modules/pkg-fixture/private.mjs": {
    kind: "esm",
    factory(ctx) {
      ctx.exportConst("kind", "package-private-import");
    }
  },
  "/workspace/node_modules/pkg-fixture/imports-consumer.cjs": {
    kind: "cjs",
    factory({ module, require }) {
      module.exports = require("#private");
    }
  },
  "/workspace/node_modules/pkg-fixture/imports-consumer.mjs": {
    kind: "esm",
    imports: ["#private"],
    factory(ctx) {
      ctx.exportConst("kind", ctx.importNamespace("#private").kind);
    }
  },
  "/workspace/node_modules/browser-conditional/browser.mjs": {
    kind: "esm",
    factory(ctx) {
      ctx.exportConst("kind", "browser-conditional");
    }
  },
  "/workspace/node_modules/browser-conditional/node.mjs": {
    kind: "esm",
    factory(ctx) {
      ctx.exportConst("kind", "node-conditional");
    }
  },
  "/workspace/node_modules/browser-conditional/node.cjs": {
    kind: "cjs",
    factory({ module }) {
      module.exports = { kind: "node-require-conditional" };
    }
  },
  "/workspace/source-entry.cjs": {
    kind: "cjs-source",
    source: `
      const path = require("node:path");
      const data = require("./fixture.json");
      exports.dirname = path.basename(__dirname);
      exports.filename = path.basename(__filename);
      exports.answer = data.answer;
    `
  },
  "/workspace/source-process-global.cjs": {
    kind: "cjs-source",
    source: `
      exports.argv = process.argv.slice();
    `
  },
  "/workspace/source-process-local.cjs": {
    kind: "cjs-source",
    source: `
      const process = { argv: ["local"] };
      exports.argv = process.argv.slice();
    `
  },
  "/workspace/source-webpack-process.cjs": {
    kind: "cjs-source",
    source: `
      module.exports =
      /******/ (function(modules) { // webpackBootstrap
        return process.argv.slice();
      })([
        function() { var process = { argv: ["nested"] }; }
      ]);
    `
  },
  "/workspace/source-webpack-buffer.cjs": {
    kind: "cjs-source",
    source: `
      module.exports =
      /******/ (function(modules) { // webpackBootstrap
        return Buffer.from([0]).constructor.name;
      })([
        function() { var Buffer = "nested"; }
      ]);
    `
  },
  "/workspace/source-webpack-global.cjs": {
    kind: "cjs-source",
    source: `
      module.exports =
      /******/ (function(modules) { // webpackBootstrap
        return global.marker;
      })([
        function() { var global = { marker: "nested" }; }
      ]);
    `
  },
  "/workspace/source-runtime-globals.cjs": {
    kind: "cjs-source",
    source: `
      exports.globalMarker = global.marker;
      exports.consoleType = typeof console.log;
    `
  },
  "/workspace/source-dynamic-import.cjs": {
    kind: "cjs-source",
    source: `
      exports.literal = 'import("./missing-in-string.cjs")';
      exports.template = \`import("./missing-in-template.cjs")\`;
      exports.commentPreserved = () => {
        // import("./missing-in-comment.cjs")
        return true;
      };
      exports.property = { import: () => "property" }.import();
      exports.loaded = import("./cjs-target.cjs");
    `
  },
  "/workspace/source-local-globals.cjs": {
    kind: "cjs-source",
    source: `
      const global = { marker: "local-global" };
      const console = { log: "local-log" };
      exports.globalMarker = global.marker;
      exports.consoleType = typeof console.log;
    `
  },
  "/workspace/source-local-globals.mjs": {
    kind: "esm-source",
    source: `
      const global = { marker: "local-esm-global" };
      const console = { log: "local-esm-log" };
      export const globalMarker = global.marker;
      export const consoleType = typeof console.log;
    `
  },
  "/workspace/source-template-export-literal.mjs": {
    kind: "esm-source",
    source: `
      const helper = "value";
      const literal = "import.meta";
      const code = \`
export default function WorkerWrapper(options) {
  import.meta.url;
  return "\${helper}:" + options.name;
}
\`;
      const metaUrl = import.meta.url;
      const finalValue = literal === "import.meta" && code.includes("export default function WorkerWrapper") && metaUrl.endsWith("/workspace/source-template-export-literal.mjs") ? helper : "missing";
      export { finalValue as value };
    `
  },
  "/workspace/dot-require/entry.cjs": {
    kind: "cjs-source",
    source: `
      exports.current = require(".").kind;
      exports.parent = require("..").kind;
    `
  },
  "/workspace/dot-require/index.js": {
    kind: "cjs-source",
    source: `
      exports.kind = "current";
    `
  },
  "/workspace/index.js": {
    kind: "cjs-source",
    source: `
      exports.kind = "parent";
    `
  },
  "/workspace/fixture.json": {
    kind: "json",
    value: {
      answer: 42
    }
  }
});

const cjsCycle = runtime.requireSync("./cjs-cycle-a.cjs", "/workspace/index.cjs");
assert.equal(cjsCycle.name, "a");
assert.equal(cjsCycle.fromB, "b");
assert.equal(cjsCycle.bSawA, "a");
assert.equal(runtime.requireSync("./linked.cjs", "/workspace/index.cjs"), cjsCycle);

const live = await runtime.importModule("./tla-dynamic.mjs", "/workspace/index.mjs");
assert.equal(live.observed, 1);
assert.equal(live.afterIncrement(), 1);

const cycle = await runtime.importModule("./cycle-a.mjs", "/workspace/index.mjs");
assert.equal(cycle.valueA, "A");
assert.equal(cycle.fromB(), "B");
const cycleB = await runtime.importModule("./cycle-b.mjs", "/workspace/index.mjs");
assert.equal(cycleB.fromA(), "A");

const cjsInterop = await runtime.importModule("./cjs-dynamic-consumer.mjs", "/workspace/index.mjs");
assert.equal(cjsInterop.hasDefault, true);
assert.equal(cjsInterop.namedStatic, "fixture");
assert.equal(cjsInterop.rendered, "value:ok");

const sourceLive = await runtime.importModule("./source-live-binding-consumer.mjs", "/workspace/index.mjs");
assert.equal(sourceLive.observed, 1);
assert.equal((await runtime.importModule("file:///workspace/file%20url%20target.mjs", "/workspace/index.mjs")).label, "file-url-target");

const sourceDefaultDeclaration = await runtime.importModule("./source-default-declaration-consumer.mjs", "/workspace/index.mjs");
assert.equal(sourceDefaultDeclaration.rendered, "label:ok:factory");
assert.deepEqual((await runtime.importModule("./source-multiline-default-call.mjs", "/workspace/index.mjs")).default, {
  plugins: ["react"]
});

const sourceAnonymousDefault = await runtime.importModule("./source-anonymous-default-consumer.mjs", "/workspace/index.mjs");
assert.equal(sourceAnonymousDefault.rendered, "anonymous:ok:anonymous-factory");

const sourceDefaultNamespace = await runtime.importModule("./source-default-namespace-import.mjs", "/workspace/index.mjs");
assert.equal(sourceDefaultNamespace.rendered, "label:ok:label:ns");
const sourceMultilineNamedImport = await runtime.importModule("./source-multiline-named-import.mjs", "/workspace/index.mjs");
assert.equal(sourceMultilineNamedImport.rendered, "label:multi");
const sourceDestructuredExport = await runtime.importModule("./source-destructured-export.mjs", "/workspace/index.mjs");
assert.equal(sourceDestructuredExport.fs, "fs-export");
assert.equal(sourceDestructuredExport.vol, "vol-export");
assert.equal((await runtime.importModule("./source-top-level-await.mjs", "/workspace/index.mjs")).label, "async-source");
assert.throws(
  () => runtime.requireSync("./source-top-level-await-require.mjs", "/workspace/index.cjs"),
  /ERR_REQUIRE_ASYNC_MODULE/
);

const pkg = await runtime.importModule("pkg-fixture", "/workspace/index.mjs");
assert.equal(pkg.kind, "package-main");
assert.equal(pkg.resolved, "/workspace/node_modules/pkg-fixture/feature.mjs");
assert.equal(runtime.requireSync("pkg-fixture", "/workspace/index.cjs").kind, "package-require-main");
assert.equal(runtime.requireSync("pkg-fixture/feature", "/workspace/index.cjs").kind, "package-feature");
assert.equal(runtime.requireSync("./imports-consumer.cjs", "/workspace/node_modules/pkg-fixture/index.cjs").kind, "package-private-require");
const packageImports = await runtime.importModule("./imports-consumer.mjs", "/workspace/node_modules/pkg-fixture/index.mjs");
assert.equal(packageImports.kind, "package-private-import");
assert.equal((await runtime.importModule("browser-conditional", "/workspace/index.mjs")).kind, "browser-conditional");
assert.equal(runtime.requireSync("browser-conditional", "/workspace/index.cjs").kind, "browser-conditional");

const sourceEntry = runtime.requireSync("./source-entry.cjs", "/workspace/index.cjs");
assert.deepEqual(sourceEntry, {
  dirname: "workspace",
  filename: "source-entry.cjs",
  answer: 42
});
const sourceDynamicImport = runtime.requireSync("./source-dynamic-import.cjs", "/workspace/index.cjs");
assert.equal(sourceDynamicImport.literal, 'import("./missing-in-string.cjs")');
assert.equal(sourceDynamicImport.template, 'import("./missing-in-template.cjs")');
assert.equal(sourceDynamicImport.commentPreserved(), true);
assert.equal(sourceDynamicImport.property, "property");
assert.equal((await sourceDynamicImport.loaded).default.kind, "fixture");
assert.deepEqual(runtime.requireSync("./source-process-global.cjs", "/workspace/index.cjs").argv, ["node", "/workspace/index.cjs", "--fixture"]);
assert.deepEqual(runtime.requireSync("./source-process-local.cjs", "/workspace/index.cjs").argv, ["local"]);
assert.deepEqual(runtime.requireSync("./source-webpack-process.cjs", "/workspace/index.cjs"), ["node", "/workspace/index.cjs", "--fixture"]);
assert.equal(runtime.requireSync("./source-webpack-buffer.cjs", "/workspace/index.cjs"), "BrowserBuffer");
assert.equal(runtime.requireSync("./source-webpack-global.cjs", "/workspace/index.cjs"), "runtime-global");
assert.deepEqual(runtime.requireSync("./source-runtime-globals.cjs", "/workspace/index.cjs"), {
  globalMarker: "runtime-global",
  consoleType: "function"
});
assert.deepEqual(runtime.requireSync("./source-local-globals.cjs", "/workspace/index.cjs"), {
  globalMarker: "local-global",
  consoleType: "string"
});
assert.deepEqual(await runtime.importModule("./source-local-globals.mjs", "/workspace/index.mjs"), {
  globalMarker: "local-esm-global",
  consoleType: "string"
});
assert.deepEqual(await runtime.importModule("./source-template-export-literal.mjs", "/workspace/index.mjs"), {
  value: "value"
});
assert.deepEqual(runtime.requireSync("./dot-require/entry.cjs", "/workspace/index.cjs"), {
  current: "current",
  parent: "parent"
});

assert.throws(
  () => runtime.resolve("pkg-fixture/private", "/workspace/index.mjs"),
  /ERR_PACKAGE_PATH_NOT_EXPORTED/
);

const lazyFiles = new Map();
const lazyRuntime = createWorkspaceModuleRuntime({
  reader: {
    listDir() {
      return [];
    },
    readText(path) {
      const value = lazyFiles.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    }
  },
  root: "/workspace"
});
lazyFiles.set("/workspace/generated-temp.mjs", "export const generated = 'runtime-created';\n");
assert.equal((await lazyRuntime.importModule("file:///workspace/generated-temp.mjs", "/workspace/index.mjs")).generated, "runtime-created");
lazyFiles.set("/workspace/generated-config.ts", "export default { plugins: ['ts-config'] as string[] };\n");
assert.deepEqual((await lazyRuntime.importModule("file:///workspace/generated-config.ts", "/workspace/index.mjs")).default, {
  plugins: ["ts-config"]
});
lazyFiles.set("/workspace/cache-reader.cjs", `
  exports.read = () => require("./mutable.json").value;
  exports.reload = () => {
    delete require.cache[require.resolve("./mutable.json")];
    return require("./mutable.json").value;
  };
`);
lazyFiles.set("/workspace/mutable.json", JSON.stringify({ value: "before" }));
const cacheReader = lazyRuntime.requireSync("./cache-reader.cjs", "/workspace/index.cjs");
assert.equal(cacheReader.read(), "before");
lazyFiles.set("/workspace/mutable.json", JSON.stringify({ value: "after" }));
assert.equal(cacheReader.read(), "before");
assert.equal(cacheReader.reload(), "after");

console.log("node modules test ok");
