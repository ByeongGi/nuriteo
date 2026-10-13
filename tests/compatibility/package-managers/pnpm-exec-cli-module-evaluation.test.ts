import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CliRegistry,
  createAsyncCliModuleEvaluator,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const installed = JSON.parse(fs.readFileSync(new URL("../../../vendor/cli/pnpm/9.15.9/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const entry = registry.resolve("pnpm");
const mountRoot = "/workspace";
const workspace = new MemoryPackageManagerWorkspace([
  ...readMounts(repoRoot, mountRoot, "vendor/cli/pnpm/9.15.9/package"),
  {
    path: "/workspace/project/package.json",
    data: JSON.stringify({
      name: "pnpm-exec-fixture",
      version: "0.0.0",
      private: true,
      scripts: {
        echo: "node -e \"console.log('pnpm-run-ok')\""
      }
    })
  },
  {
    path: "/workspace/project/node_modules/.bin/local-bin",
    data: "#!/usr/bin/env node\nconsole.log('pnpm-exec-ok');\n"
  },
  {
    path: "/workspace/project/node_modules/local-bin/package.json",
    data: JSON.stringify({
      name: "local-bin",
      version: "1.0.0",
      bin: {
        "local-bin": "cli.js"
      }
    })
  },
  {
    path: "/workspace/project/node_modules/local-bin/cli.js",
    data: "#!/usr/bin/env node\nconsole.log('pnpm-exec-ok');\n"
  }
]);
const evaluate = createAsyncCliModuleEvaluator({
  root: mountRoot,
  reader: workspace,
  writer: workspace,
  settleTicks: 100,
  settleTimeoutMs: 200
});
const cliEntry = {
  ...entry,
  entry: `${mountRoot}/${path.relative(repoRoot, entry.entry)}`
};
const env = {
  HOME: "/home/webcontainer",
  PATH: "/workspace/project/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
  npm_config_user_agent: `pnpm/${installed.version} node/v22.23.0 browser`
};

const run = await evaluate({
  entry: cliEntry,
  args: ["--reporter", "silent", "run", "echo"],
  cwd: "/workspace/project",
  env
});

assert.equal(run.stderr, "");
assert.equal(run.exitCode, 0);
assert.match(run.stdout, /pnpm-run-ok/);

const result = await evaluate({
  entry: cliEntry,
  args: ["exec", "local-bin"],
  cwd: "/workspace/project",
  env
});

assert.equal(result.stderr, "");
assert.equal(result.exitCode, 0);
assert.equal(result.stdout, "pnpm-exec-ok\n");

console.log("pnpm exec cli module evaluation test ok");

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
