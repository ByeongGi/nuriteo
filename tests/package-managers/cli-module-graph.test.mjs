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
  assert.ok(graph.issues.some((issue) => issue.kind === "dynamic-require"));
  if (name === "npm") {
    assert.equal(graph.issues.some((issue) => issue.kind === "unsupported-builtin"), false);
  } else {
    assert.ok(graph.issues.some((issue) => issue.kind === "optional-cache-probe"));
    assert.ok(graph.issues.some((issue) => issue.kind === "unsupported-builtin"));
  }
  assert.equal(graph.supported, false);
}

console.log("package manager cli module graph test ok");
