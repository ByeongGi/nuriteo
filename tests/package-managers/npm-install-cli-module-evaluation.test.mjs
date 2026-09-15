import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CliRegistry,
  createAsyncCliModuleEvaluator,
  MemoryPackageManagerWorkspace
} from "../../packages/node-runtime/src/index.ts";

const repoRoot = new URL("../..", import.meta.url).pathname;
const installed = JSON.parse(fs.readFileSync(new URL("../../vendor/cli/npm/10.9.2/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const entry = registry.resolve("npm");
const mountRoot = "/workspace";
const workspace = new MemoryPackageManagerWorkspace([
  ...readMounts(repoRoot, mountRoot, "vendor/cli/npm/10.9.2/package"),
  {
    path: "/workspace/local-dep/package.json",
    data: JSON.stringify({
      name: "local-dep",
      version: "1.0.0",
      main: "index.js"
    })
  },
  {
    path: "/workspace/local-dep/index.js",
    data: "module.exports = 'local-dep';\n"
  },
  {
    path: "/workspace/project/package.json",
    data: JSON.stringify({
      name: "npm-install-fixture",
      version: "0.0.0",
      private: true,
      scripts: {},
      dependencies: {
        "local-dep": "file:../local-dep"
      }
    })
  }
]);
const evaluate = createAsyncCliModuleEvaluator({
  root: mountRoot,
  reader: workspace,
  writer: workspace,
  settleTicks: 100,
  settleTimeoutMs: 200
});

const result = await evaluate({
  entry: {
    ...entry,
    entry: `${mountRoot}/${path.relative(repoRoot, entry.entry)}`
  },
  args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--update-notifier=false"],
  cwd: "/workspace/project",
  env: {
    HOME: "/home/webcontainer",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    npm_config_user_agent: `npm/${installed.version} node/v22.23.0 browser`
  }
});

assert.equal(result.stderr, "");
assert.equal(result.exitCode, 0);
assert.match(result.stdout, /added 1 package/);
assert.equal(workspace.exists("/workspace/project/node_modules"), true);
assert.equal(workspace.exists("/workspace/project/node_modules/local-dep/package.json"), true);
const lockfile = JSON.parse(workspace.readText("/workspace/project/package-lock.json"));
assert.equal(lockfile.lockfileVersion, 3);
assert.equal(lockfile.packages["node_modules/local-dep"].link, true);

workspace.remove("/workspace/project/node_modules");
const ciResult = await evaluate({
  entry: {
    ...entry,
    entry: `${mountRoot}/${path.relative(repoRoot, entry.entry)}`
  },
  args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--update-notifier=false"],
  cwd: "/workspace/project",
  env: {
    HOME: "/home/webcontainer",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    npm_config_user_agent: `npm/${installed.version} node/v22.23.0 browser`
  }
});

assert.equal(ciResult.stderr, "");
assert.equal(ciResult.exitCode, 0);
assert.match(ciResult.stdout, /added 1 package/);
assert.equal(workspace.exists("/workspace/project/node_modules/local-dep/package.json"), true);

console.log("npm install cli module evaluation test ok");

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
