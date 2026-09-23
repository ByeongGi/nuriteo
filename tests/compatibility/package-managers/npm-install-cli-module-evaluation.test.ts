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
    path: "/workspace/local-dep/package.json",
    data: JSON.stringify({
      name: "local-dep",
      version: "1.0.0",
      main: "index.js",
      bin: {
        "local-dep": "cli.js"
      },
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
    path: "/workspace/local-dep/cli.js",
    data: "#!/usr/bin/env node\nconsole.log('local-dep-bin');\n"
  },
  {
    path: "/workspace/local-dep/install.js",
    data: "require('fs').writeFileSync('lifecycle-marker.txt', 'local-dep:installed\\n');\n"
  },
  {
    path: "/workspace/fixture-peer-provider/package.json",
    data: JSON.stringify({
      name: "fixture-peer-provider",
      version: "1.0.0",
      main: "index.js"
    })
  },
  {
    path: "/workspace/fixture-peer-provider/index.js",
    data: "exports.hello = () => 'provider';\n"
  },
  {
    path: "/workspace/fixture-peer-consumer/package.json",
    data: JSON.stringify({
      name: "fixture-peer-consumer",
      version: "1.0.0",
      main: "index.js",
      peerDependencies: {
        "fixture-peer-provider": "^1.0.0"
      }
    })
  },
  {
    path: "/workspace/fixture-peer-consumer/index.js",
    data: "const provider = require('fixture-peer-provider');\nexports.hello = () => `consumer:${provider.hello()}`;\n"
  },
  {
    path: "/workspace/fixture-optional/package.json",
    data: JSON.stringify({
      name: "fixture-optional",
      version: "1.0.0",
      main: "index.js",
      scripts: {
        install: "node install.js"
      }
    })
  },
  {
    path: "/workspace/fixture-optional/index.js",
    data: "module.exports = 'optional-ok';\n"
  },
  {
    path: "/workspace/fixture-optional/install.js",
    data: "require('fs').writeFileSync('optional-marker.txt', 'fixture-optional:installed\\n');\n"
  },
  {
    path: "/workspace/project/package.json",
    data: JSON.stringify({
      name: "npm-install-fixture",
      version: "0.0.0",
      private: true,
      scripts: {},
      dependencies: {
        "fixture-peer-consumer": "file:../fixture-peer-consumer",
        "fixture-peer-provider": "file:../fixture-peer-provider",
        "local-dep": "file:../local-dep"
      },
      optionalDependencies: {
        "fixture-optional": "file:../fixture-optional"
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
  args: ["install", "--no-audit", "--no-fund", "--update-notifier=false"],
  cwd: "/workspace/project",
  env: {
    HOME: "/home/webcontainer",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    npm_config_user_agent: `npm/${installed.version} node/v22.23.0 browser`
  }
});

assert.equal(result.stderr, "");
assert.equal(result.exitCode, 0);
assert.match(result.stdout, /added 4 packages/);
assert.equal(workspace.exists("/workspace/project/node_modules"), true);
assert.equal(workspace.exists("/workspace/project/node_modules/local-dep/package.json"), true);
assert.equal(workspace.exists("/workspace/project/node_modules/.bin/local-dep"), true);
assert.equal(workspace.readText("/workspace/project/node_modules/local-dep/lifecycle-marker.txt"), "local-dep:installed\n");
assert.equal(workspace.exists("/workspace/project/node_modules/fixture-peer-consumer/package.json"), true);
assert.equal(workspace.exists("/workspace/project/node_modules/fixture-peer-provider/package.json"), true);
assert.equal(workspace.exists("/workspace/project/node_modules/fixture-optional/package.json"), true);
assert.equal(workspace.readText("/workspace/project/node_modules/fixture-optional/optional-marker.txt"), "fixture-optional:installed\n");
const lockfile = JSON.parse(workspace.readText("/workspace/project/package-lock.json"));
assert.equal(lockfile.lockfileVersion, 3);
assert.equal(lockfile.packages["node_modules/local-dep"].link, true);
assert.equal(lockfile.packages["node_modules/fixture-peer-consumer"].link, true);
const peerConsumerManifest = JSON.parse(workspace.readText("/workspace/project/node_modules/fixture-peer-consumer/package.json"));
assert.equal(peerConsumerManifest.peerDependencies["fixture-peer-provider"], "^1.0.0");
assert.equal(lockfile.packages[""].optionalDependencies["fixture-optional"], "file:../fixture-optional");

workspace.remove("/workspace/project/node_modules");
const ciResult = await evaluate({
  entry: {
    ...entry,
    entry: `${mountRoot}/${path.relative(repoRoot, entry.entry)}`
  },
  args: ["ci", "--no-audit", "--no-fund", "--update-notifier=false"],
  cwd: "/workspace/project",
  env: {
    HOME: "/home/webcontainer",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    npm_config_user_agent: `npm/${installed.version} node/v22.23.0 browser`
  }
});

assert.equal(ciResult.stderr, "");
assert.equal(ciResult.exitCode, 0);
assert.match(ciResult.stdout, /added 4 packages/);
assert.equal(workspace.exists("/workspace/project/node_modules/local-dep/package.json"), true);
assert.equal(workspace.exists("/workspace/project/node_modules/.bin/local-dep"), true);
assert.equal(workspace.readText("/workspace/project/node_modules/local-dep/lifecycle-marker.txt"), "local-dep:installed\n");
assert.equal(workspace.exists("/workspace/project/node_modules/fixture-peer-consumer/package.json"), true);
assert.equal(workspace.exists("/workspace/project/node_modules/fixture-peer-provider/package.json"), true);
assert.equal(workspace.exists("/workspace/project/node_modules/fixture-optional/package.json"), true);
assert.equal(workspace.readText("/workspace/project/node_modules/fixture-optional/optional-marker.txt"), "fixture-optional:installed\n");

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
