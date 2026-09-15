import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CliRegistry,
  createAsyncCliModuleEvaluator,
  MemoryPackageManagerWorkspace
} from "../../packages/node-runtime/src/index.ts";

const repoRoot = new URL("../..", import.meta.url).pathname;
const installed = JSON.parse(fs.readFileSync(new URL("../../vendor/cli/pnpm/9.15.9/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const entry = registry.resolve("pnpm");
const mountRoot = "/workspace";
const workspace = new MemoryPackageManagerWorkspace([
  ...readMounts(repoRoot, mountRoot, "vendor/cli/pnpm/9.15.9/package"),
  {
    path: "/workspace/local-dep/package.json",
    data: JSON.stringify({
      name: "local-dep",
      version: "1.0.0",
      main: "index.js",
      scripts: {
        install: "node install.js"
      }
    })
  },
  {
    path: "/workspace/local-dep/index.js",
    data: "module.exports = 'local-dep';\n"
  },
  {
    path: "/workspace/local-dep/install.js",
    data: "require('fs').writeFileSync('lifecycle-marker.txt', 'local-dep:installed\\n');\n"
  },
  {
    path: "/workspace/project/package.json",
    data: JSON.stringify({
      name: "pnpm-install-fixture",
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
  settleTicks: 2000,
  settleTimeoutMs: 5000
});

const result = await evaluate({
  entry: {
    ...entry,
    entry: `${mountRoot}/${path.relative(repoRoot, entry.entry)}`
  },
  args: ["install", "--offline", "--reporter", "silent", "--store-dir", "/workspace/.pnpm-store"],
  cwd: "/workspace/project",
  env: {
    CI: "true",
    HOME: "/home/webcontainer",
    PNPM_HOME: "/home/webcontainer/.local/share/pnpm",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    npm_config_user_agent: `pnpm/${installed.version} node/v22.23.0 browser`
  }
});

assert.equal(result.stdout, "");
assert.equal(result.stderr, "");
assert.equal(result.exitCode, 0);
const installedManifest = JSON.parse(workspace.readText("/workspace/project/node_modules/local-dep/package.json"));
assert.equal(installedManifest.name, "local-dep");
assert.equal(installedManifest.scripts.install, "node install.js");
assert.equal(workspace.readText("/workspace/project/node_modules/local-dep/index.js"), "module.exports = 'local-dep';\n");
assert.equal(workspace.readText("/workspace/project/node_modules/local-dep/lifecycle-marker.txt"), "local-dep:installed\n");
assert.match(workspace.readText("/workspace/project/pnpm-lock.yaml"), /local-dep@file:\.\.\/local-dep/);
assert.match(workspace.readText("/workspace/project/node_modules/.modules.yaml"), /packageManager: pnpm@9\.15\.9/);
assert.match(workspace.readText("/workspace/project/node_modules/.pnpm/lock.yaml"), /specifier: file:\.\.\/local-dep/);

console.log("pnpm install cli module evaluation test ok");

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
