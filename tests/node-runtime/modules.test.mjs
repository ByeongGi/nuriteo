import assert from "node:assert/strict";

import { createBuiltinLoader } from "../../packages/node-runtime/src/builtin-loader.ts";
import { createModuleRuntime } from "../../packages/node-runtime/src/modules/index.ts";

const runtime = createModuleRuntime({
  builtins: createBuiltinLoader({}),
  globals: {
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
  "/workspace/source-runtime-globals.cjs": {
    kind: "cjs-source",
    source: `
      exports.globalMarker = global.marker;
      exports.consoleType = typeof console.log;
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

const sourceDefaultDeclaration = await runtime.importModule("./source-default-declaration-consumer.mjs", "/workspace/index.mjs");
assert.equal(sourceDefaultDeclaration.rendered, "label:ok:factory");

const sourceAnonymousDefault = await runtime.importModule("./source-anonymous-default-consumer.mjs", "/workspace/index.mjs");
assert.equal(sourceAnonymousDefault.rendered, "anonymous:ok:anonymous-factory");

const pkg = await runtime.importModule("pkg-fixture", "/workspace/index.mjs");
assert.equal(pkg.kind, "package-main");
assert.equal(pkg.resolved, "/workspace/node_modules/pkg-fixture/feature.mjs");
assert.equal(runtime.requireSync("pkg-fixture", "/workspace/index.cjs").kind, "package-require-main");
assert.equal(runtime.requireSync("pkg-fixture/feature", "/workspace/index.cjs").kind, "package-feature");

const sourceEntry = runtime.requireSync("./source-entry.cjs", "/workspace/index.cjs");
assert.deepEqual(sourceEntry, {
  dirname: "workspace",
  filename: "source-entry.cjs",
  answer: 42
});
assert.deepEqual(runtime.requireSync("./source-process-global.cjs", "/workspace/index.cjs").argv, ["node", "/workspace/index.cjs", "--fixture"]);
assert.deepEqual(runtime.requireSync("./source-process-local.cjs", "/workspace/index.cjs").argv, ["local"]);
assert.deepEqual(runtime.requireSync("./source-runtime-globals.cjs", "/workspace/index.cjs"), {
  globalMarker: "runtime-global",
  consoleType: "function"
});
assert.deepEqual(runtime.requireSync("./source-local-globals.cjs", "/workspace/index.cjs"), {
  globalMarker: "local-global",
  consoleType: "string"
});
assert.deepEqual(runtime.requireSync("./dot-require/entry.cjs", "/workspace/index.cjs"), {
  current: "current",
  parent: "parent"
});

assert.throws(
  () => runtime.resolve("pkg-fixture/private", "/workspace/index.mjs"),
  /ERR_PACKAGE_PATH_NOT_EXPORTED/
);

console.log("node modules test ok");
