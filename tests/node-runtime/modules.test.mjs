import assert from "node:assert/strict";

import { createModuleRuntime } from "../../packages/node-runtime/src/modules/index.ts";

const runtime = createModuleRuntime({
  imports: {
    "#counter": "./live-binding.mjs"
  },
  packages: {
    "pkg-fixture": {
      root: "/workspace/node_modules/pkg-fixture",
      type: "module",
      exports: {
        ".": "./main.mjs",
        "./feature": "./feature.cjs"
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
  "/workspace/node_modules/pkg-fixture/main.mjs": {
    kind: "esm",
    factory(ctx) {
      ctx.exportConst("kind", "package-main");
      ctx.exportConst("resolved", ctx.importMeta.resolve("pkg-fixture/feature"));
    }
  },
  "/workspace/node_modules/pkg-fixture/feature.cjs": {
    kind: "cjs",
    factory({ module }) {
      module.exports = { kind: "package-feature" };
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

const pkg = await runtime.importModule("pkg-fixture", "/workspace/index.mjs");
assert.equal(pkg.kind, "package-main");
assert.equal(pkg.resolved, "/workspace/node_modules/pkg-fixture/feature.cjs");

assert.throws(
  () => runtime.resolve("pkg-fixture/private", "/workspace/index.mjs"),
  /ERR_PACKAGE_PATH_NOT_EXPORTED/
);

console.log("node modules test ok");
