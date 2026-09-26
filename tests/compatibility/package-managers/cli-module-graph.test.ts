import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { analyzeCliModuleGraph, extractStaticEsmSpecifiers, extractStaticRequires } from "../../../packages/node-runtime/src/index.ts";

const root = new URL("../../..", import.meta.url).pathname;

assert.deepEqual(
  extractStaticRequires(`
    const path = require('node:path');
    const local = require("./local");
    const dynamic = require(entry);
    const text = 'require("not-a-real-import")';
    // const commented = require("not-a-comment-import");
    /*
      const block = require("not-a-block-import");
    */
  `),
  ["./local", "<dynamic>", "node:path"]
);

assert.deepEqual(
  extractStaticRequires(`
    /**
     * const braces = require('braces');
     */
    const loaded = tsx.require(name, rootFile);
    const real = require("real-package");
  `),
  ["real-package"]
);

assert.deepEqual(
  extractStaticRequires(
    `
      const cliEntry = require('node:path').resolve(__dirname, 'cli/entry.js');
      module.exports = () => require(cliEntry);
    `,
    { filename: "/workspace/package/lib/cli.js" }
  ),
  ["/workspace/package/lib/cli/entry.js", "node:path"]
);

assert.deepEqual(
  extractStaticRequires("return require(`./commands/${command}.js`)"),
  ["./commands/${command}.js"]
);

assert.deepEqual(
  extractStaticRequires(
    "defaultsObject['npm-version'] = require(join(this.npmPath, 'package.json')).version",
    { filename: "/workspace/npm/node_modules/@npmcli/config/lib/index.js" }
  ),
  ["/workspace/npm/package.json"]
);

assert.deepEqual(
  extractStaticRequires("return new (require(adapters[adapter]))(options)"),
  ["<keyv-adapter>"]
);

assert.deepEqual(
  extractStaticRequires("const pnpmfile = require(pnpmFilePath)"),
  ["<pnpmfile>"]
);

assert.deepEqual(
  extractStaticRequires("const { devDependencies } = require(packageJsonPath)"),
  ["<project-package-json>"]
);

assert.deepEqual(
  extractStaticEsmSpecifiers(`
    import "side-effect-pkg";
    import defaultExport from "./default.js";
    import { named as renamed } from "named-pkg";
    import * as namespace from "namespace-pkg";
    export { value } from "./re-export.js";
    export * from "star-pkg";
    export * as starNamespace from "star-namespace-pkg";
    const text = 'import "not-a-real-import"';
    // import "not-a-comment-import";
    /*
      export * from "not-a-block-export";
    */
    await import("dynamic-pkg");
    import("./lazy-local.js");
  `),
  ["./default.js", "./lazy-local.js", "./re-export.js", "dynamic-pkg", "named-pkg", "namespace-pkg", "side-effect-pkg", "star-namespace-pkg", "star-pkg"]
);

const esmGraphFiles = new Map([
  ["/workspace/vite/bin/vite.js", "function start() {\n  return import('../dist/node/cli.js');\n}\nstart();\n"],
  ["/workspace/vite/dist/node/cli.js", "import { start } from './server.js';\nimport 'conditional-pkg';\nimport 'conditional-pkg/features/render';\nimport 'browser-main-pkg';\nimport 'browser-export-pkg';\nimport 'node:fs';\nimport 'node:perf_hooks';\nstart();\n"],
  ["/workspace/vite/dist/node/server.js", "export * as hmr from './hmr.js';\nexport const start = () => undefined;\n"],
  ["/workspace/vite/dist/node/hmr.js", "export const channel = 'hmr';\n"],
  ["/workspace/vite/node_modules/conditional-pkg/package.json", JSON.stringify({
    name: "conditional-pkg",
    imports: {
      "#private": {
        import: "./private.mjs",
        default: "./private.js"
      }
    },
    exports: {
      ".": {
        import: "./esm.mjs",
        require: "./cjs.cjs"
      },
      "./features/*": {
        import: "./features/*.mjs",
        default: "./features/*.js"
      }
    }
  })],
  ["/workspace/vite/node_modules/conditional-pkg/esm.mjs", "import '#private';\nexport const mode = 'esm';\n"],
  ["/workspace/vite/node_modules/conditional-pkg/private.mjs", "export const value = 'private';\n"],
  ["/workspace/vite/node_modules/conditional-pkg/features/render.mjs", "export const render = () => undefined;\n"],
  ["/workspace/vite/node_modules/browser-main-pkg/package.json", JSON.stringify({
    name: "browser-main-pkg",
    main: "node.cjs",
    browser: "browser.js"
  })],
  ["/workspace/vite/node_modules/browser-main-pkg/node.cjs", "module.exports = { mode: 'node' };\n"],
  ["/workspace/vite/node_modules/browser-main-pkg/browser.js", "export const mode = 'browser-main';\n"],
  ["/workspace/vite/node_modules/browser-export-pkg/package.json", JSON.stringify({
    name: "browser-export-pkg",
    exports: {
      ".": {
        browser: "./browser.mjs",
        import: "./node.mjs"
      }
    }
  })],
  ["/workspace/vite/node_modules/browser-export-pkg/browser.mjs", "export const mode = 'browser-export';\n"],
  ["/workspace/vite/node_modules/browser-export-pkg/node.mjs", "export const mode = 'node-export';\n"]
]);
const esmGraph = analyzeCliModuleGraph({
  entry: "/workspace/vite/bin/vite.js",
  packageRoot: "/workspace/vite",
  reader: {
    exists(file) {
      return esmGraphFiles.has(file);
    },
    readText(file) {
      const source = esmGraphFiles.get(file);
      if (source === undefined) throw new Error(`missing ${file}`);
      return source;
    }
  }
});
assert.equal(esmGraph.supported, true);
assert.deepEqual(
  esmGraph.modules.map((mod) => [mod.path, mod.imports]),
  [
    ["/workspace/vite/bin/vite.js", ["../dist/node/cli.js"]],
    ["/workspace/vite/dist/node/cli.js", ["./server.js", "browser-export-pkg", "browser-main-pkg", "conditional-pkg", "conditional-pkg/features/render", "node:fs", "node:perf_hooks"]],
    ["/workspace/vite/dist/node/server.js", ["./hmr.js"]],
    ["/workspace/vite/node_modules/browser-export-pkg/browser.mjs", []],
    ["/workspace/vite/node_modules/browser-main-pkg/browser.js", []],
    ["/workspace/vite/node_modules/conditional-pkg/esm.mjs", ["#private"]],
    ["/workspace/vite/node_modules/conditional-pkg/features/render.mjs", []],
    ["/workspace/vite/dist/node/hmr.js", []],
    ["/workspace/vite/node_modules/conditional-pkg/private.mjs", []]
  ]
);

const selfReferenceFiles = new Map([
  ["/workspace/node_modules/example/package.json", JSON.stringify({ name: "example" })],
  ["/workspace/node_modules/example/bin/cli.js", "require('example/dist/internal')"],
  ["/workspace/node_modules/example/dist/internal/package.json", JSON.stringify({ main: "runtime.cjs" })],
  ["/workspace/node_modules/example/dist/internal/runtime.cjs", "module.exports = true"]
]);
const selfReferenceGraph = analyzeCliModuleGraph({
  entry: "/workspace/node_modules/example/bin/cli.js",
  packageRoot: "/workspace/node_modules/example",
  reader: {
    exists(file) {
      return selfReferenceFiles.has(file);
    },
    isFile(file) {
      return selfReferenceFiles.has(file);
    },
    readText(file) {
      const source = selfReferenceFiles.get(file);
      if (source === undefined) throw new Error(`missing ${file}`);
      return source;
    }
  }
});
assert.equal(selfReferenceGraph.supported, true);
assert.deepEqual(selfReferenceGraph.modules.map((mod) => mod.path), [
  "/workspace/node_modules/example/bin/cli.js",
  "/workspace/node_modules/example/dist/internal/runtime.cjs"
]);

for (const [name, version] of [["npm", "10.9.2"], ["pnpm", "9.15.9"]]) {
  const installed = JSON.parse(fs.readFileSync(path.join(root, `vendor/cli/${name}/${version}/installed.json`), "utf8"));
  const installedEntry = path.resolve(root, installed.entryRelative || installed.entry);
  const packageRoot = path.join(root, `vendor/cli/${name}/${version}/package`);
  const graph = analyzeCliModuleGraph({
    entry: installedEntry,
    packageRoot,
    maxModules: 2048,
    reader: {
      exists(file) {
        return fs.existsSync(file);
      },
      isFile(file) {
        return fs.statSync(file).isFile();
      },
      listFiles(file) {
        return fs.readdirSync(file);
      },
      readText(file) {
        return fs.readFileSync(file, "utf8");
      }
    }
  });

  assert.equal(graph.entry, installedEntry);
  assert.ok(graph.modules.length >= 2, `${name} graph should walk past the bin entry`);
  assert.equal(graph.modules[0].path, installedEntry);
  assert.ok(graph.modules.some((mod) => mod.path.includes(name === "npm" ? "/lib/cli.js" : "/dist/pnpm.cjs")));
  assert.equal(graph.issues.some((issue) => issue.kind === "missing-module"), false);
  assert.equal(graph.issues.some((issue) => issue.kind === "unsupported-builtin"), false);
  if (name === "npm") {
    assert.ok(graph.modules.length > 500);
    assert.equal(graph.issues.some((issue) => issue.kind === "dynamic-command-dispatch"), false);
    assert.ok(graph.modules.some((mod) => mod.path.endsWith("/lib/commands/install.js")));
    assert.ok(graph.modules.some((mod) => mod.path.endsWith("/lib/commands/run-script.js")));
    assert.equal(graph.issues.some((issue) => issue.kind === "dynamic-config-probe"), false);
    assert.ok(graph.issues.some((issue) => issue.kind === "optional-dependency-probe"));
    assert.equal(graph.supported, true);
  } else {
    assert.equal(graph.issues.some((issue) => issue.kind === "dynamic-adapter-dispatch"), false);
    assert.ok(graph.issues.some((issue) => issue.kind === "optional-cache-probe"));
    assert.ok(graph.issues.some((issue) => issue.kind === "optional-dependency-probe"));
    assert.equal(graph.supported, true);
  }
}

console.log("package manager cli module graph test ok");
