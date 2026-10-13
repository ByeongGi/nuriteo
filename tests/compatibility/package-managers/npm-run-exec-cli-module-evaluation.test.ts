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
const workspace = new MemoryPackageManagerWorkspace([
  ...readMounts(repoRoot, mountRoot, "vendor/cli/npm/10.9.2/package"),
  {
    path: "/workspace/project/package.json",
    data: JSON.stringify({
      name: "npm-run-exec-fixture",
      version: "0.0.0",
      private: true,
      scripts: {
        echo: "node -e \"console.log('run-ok')\""
      }
    })
  },
  {
    path: "/workspace/project/node_modules/.bin/local-bin",
    data: "#!/usr/bin/env node\nconsole.log('exec-ok');\n"
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
    data: "#!/usr/bin/env node\nconsole.log('exec-ok');\n"
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
  npm_config_user_agent: `npm/${installed.version} node/v22.23.0 browser`
};

const run = await evaluate({
  entry: cliEntry,
  args: ["run", "echo", "--update-notifier=false"],
  cwd: "/workspace/project",
  env
});

assert.equal(run.stderr, "");
assert.equal(run.exitCode, 0);
assert.match(run.stdout, /run-ok/);

const exec = await evaluate({
  entry: cliEntry,
  args: ["exec", "--update-notifier=false", "--", "local-bin"],
  cwd: "/workspace/project",
  env
});

assert.equal(exec.stderr, "");
assert.equal(exec.exitCode, 0);
assert.match(exec.stdout, /exec-ok/);

console.log("npm run exec cli module evaluation test ok");

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
