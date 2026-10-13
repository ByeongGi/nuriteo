import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { analyzeCliModuleGraph } from "../../../packages/node-runtime/src/package-managers/cli-module-graph.ts";

const root = path.resolve(new URL("../../..", import.meta.url).pathname);
const gate = readJson("compat/yarn-v1-product-support.json");
const installed = readJson(gate.artifact.installed);
const entry = path.join(root, gate.artifact.entry);
const bundle = path.join(root, gate.artifact.bundle);

assert.equal(installed.mode, "real-tarball");
assert.equal(installed.version, gate.version);
assert.equal(sha256(entry), gate.artifact.entrySha256);
assert.equal(sha256(bundle), gate.artifact.bundleSha256);
assert.equal(fs.statSync(bundle).size, gate.artifact.bundleBytes);

const graph = analyzeCliModuleGraph({
  entry: bundle,
  packageRoot: path.dirname(path.dirname(bundle)),
  maxModules: 4096,
  reader: {
    exists: fs.existsSync,
    isFile(file) { return fs.statSync(file).isFile(); },
    listFiles: fs.readdirSync,
    readText(file) { return fs.readFileSync(file, "utf8"); }
  }
});
assert.equal(graph.supported, true);
assert.equal(graph.modules.length, 1, "Yarn Classic's checked artifact is a self-contained webpack bundle");
assert.equal(readJson("vendor/cli/yarn/1.22.22/package/package.json").version, gate.version);

console.log("yarn vendored CLI artifact test ok");

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
