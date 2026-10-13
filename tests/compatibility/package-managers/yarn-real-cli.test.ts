import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createAsyncCliModuleEvaluator } from "../../../packages/node-runtime/src/package-managers/cli-evaluator.ts";
import { MemoryPackageManagerWorkspace } from "../../../packages/node-runtime/src/package-managers/workspace.ts";

const repositoryRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const artifactRoot = path.join(repositoryRoot, "vendor/cli/yarn/1.22.22/package");
const guestRoot = "/workspace/vendor/yarn/package";
const workspace = new MemoryPackageManagerWorkspace([
  file("bin/yarn.js"),
  file("lib/cli.js"),
  file("lib/v8-compile-cache.js"),
  file("package.json"),
  { path: "/workspace/project/package.json", data: JSON.stringify({ name: "yarn-real-cli-fixture", private: true }) }
]);

const result = await createAsyncCliModuleEvaluator({
  reader: workspace,
  root: "/workspace",
  settleTicks: 100,
  settleTimeoutMs: 50,
  writer: workspace
})({
  args: ["--version"],
  cwd: "/workspace/project",
  entry: {
    entry: `${guestRoot}/bin/yarn.js`,
    name: "yarn",
    version: "1.22.22"
  }
});

assert.equal(result.exitCode, 0, result.stderr);
assert.equal(result.stderr, "");
assert.equal(result.stdout, "1.22.22\n");

console.log("yarn real CLI version test ok");

function file(relativePath) {
  return {
    path: `${guestRoot}/${relativePath}`,
    data: fs.readFileSync(path.join(artifactRoot, relativePath), "utf8")
  };
}
