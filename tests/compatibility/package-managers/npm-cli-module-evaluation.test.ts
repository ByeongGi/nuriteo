import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CliRegistry,
  createAsyncCliModuleEvaluator,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const installed = JSON.parse(fs.readFileSync(new URL("../../../vendor/cli/npm/10.9.2/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const entry = registry.resolve("npm");
const mountRoot = "/workspace";
const workspace = new MemoryPackageManagerWorkspace(readMounts(repoRoot, mountRoot, "vendor/cli/npm/10.9.2/package"));
const evaluate = createAsyncCliModuleEvaluator({
  root: mountRoot,
  reader: workspace,
  settleTicks: 50,
  settleTimeoutMs: 100
});

const result = await evaluate({
  entry: {
    ...entry,
    entry: `${mountRoot}/${path.relative(repoRoot, entry.entry)}`
  },
  args: ["--version"],
  cwd: "/workspace/project",
  env: {
    HOME: "/home/webcontainer",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    npm_config_user_agent: `npm/${installed.version} node/v22.23.0 browser`
  }
});

assert.equal(result.stdout, `${installed.version}\n`);
assert.equal(result.stderr, "");
assert.equal(result.exitCode, 0);
assert.equal(result.entry, "/workspace/vendor/cli/npm/10.9.2/package/bin/npm-cli.js");

console.log("npm cli module evaluation test ok");

function readMounts(repoRoot, mountRoot, relativeSource) {
  const sourceRoot = path.join(repoRoot, relativeSource);
  const mounts = [];
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const sourceRelative = path.relative(repoRoot, sourcePath);
    const targetPath = `${mountRoot}/${sourceRelative}`;
    if (entry.isDirectory()) {
      mounts.push(...readMounts(repoRoot, mountRoot, sourceRelative));
    } else if (entry.isFile()) {
      mounts.push({
        path: targetPath,
        data: fs.readFileSync(sourcePath, "utf8")
      });
    }
  }
  return mounts;
}
