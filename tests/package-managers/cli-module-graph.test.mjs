import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { analyzeCliModuleGraph, extractStaticRequires } from "../../packages/node-runtime/src/index.ts";

const root = new URL("../..", import.meta.url).pathname;

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

for (const [name, version] of [["npm", "10.9.2"], ["pnpm", "9.15.9"]]) {
  const installed = JSON.parse(fs.readFileSync(path.join(root, `vendor/cli/${name}/${version}/installed.json`), "utf8"));
  const packageRoot = path.join(root, `vendor/cli/${name}/${version}/package`);
  const graph = analyzeCliModuleGraph({
    entry: installed.entry,
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

  assert.equal(graph.entry, installed.entry);
  assert.ok(graph.modules.length >= 2, `${name} graph should walk past the bin entry`);
  assert.equal(graph.modules[0].path, installed.entry);
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
