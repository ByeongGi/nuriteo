import assert from "node:assert/strict";

import {
  createGuestRuntimeProcessRunner,
  createNpmRunner,
  createPackageExecutionPolicy,
  createPackageScriptRunner,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";

const workspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/package.json",
    data: JSON.stringify({
      scripts: {
        build: "node scripts/build.js",
        native: "node scripts/native.js",
        huge: "node scripts/huge.js"
      }
    })
  },
  {
    path: "/workspace/scripts/build.js",
    data: "console.log(\"fixture-bin:hello\")\n"
  },
  {
    path: "/workspace/scripts/native.js",
    data: "require('./native.node')\n"
  },
  {
    path: "/workspace/scripts/huge.js",
    data: "x".repeat(64)
  },
  {
    path: "/workspace/packages/native/package.json",
    data: JSON.stringify({
      scripts: {
        install: "node-gyp rebuild"
      }
    })
  },
  {
    path: "/workspace/packages/native/install.js",
    data: "console.log(\"fixture-bin:hello\")\n"
  },
  {
    path: "/workspace/node_modules/.bin/native-tool",
    data: "#!/usr/bin/env node\nrequire('./addon.node')\n"
  }
]);

const runner = createPackageScriptRunner({
  cwd: "/workspace",
  reader: workspace,
  writer: workspace,
  policy: createPackageExecutionPolicy({
    lifecycleScripts: "deny",
    maxScriptBytes: 48
  })
});

const build = runner.runScript("build");
assert.equal(build.exitCode, 0, build.stderr);
assert.equal(build.error, undefined);

const lifecycle = runner.runLifecycle("/workspace/packages/native", "install");
assert.equal(lifecycle.exitCode, 1);
assert.equal(lifecycle.error.code, "ERR_PM_LIFECYCLE_BLOCKED");

const native = runner.runScript("native");
assert.equal(native.exitCode, 1);
assert.equal(native.error.code, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");

const huge = runner.runScript("huge");
assert.equal(huge.exitCode, 1);
assert.equal(huge.error.code, "ERR_PM_RESOURCE_LIMIT");

const bin = runner.execBin("native-tool");
assert.equal(bin.exitCode, 1);
assert.equal(bin.error.code, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");

const npm = createNpmRunner({
  registry: {
    resolve(name) {
      return {
        name,
        version: "10.9.2",
        entry: "/workspace/npm/bin/npm-cli.js"
      };
    }
  },
  processRunner: createGuestRuntimeProcessRunner({
    artifacts: {
      readText() {
        return "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n";
      }
    },
    workspace: {
      reader: workspace,
      writer: workspace,
      scriptPolicy: createPackageExecutionPolicy({ maxScriptBytes: 48 })
    }
  })
});
const npmNative = npm.runScript("/workspace", "native");
assert.equal(npmNative.exitCode, 1);
assert.equal(npmNative.stderr.includes("native addon execution is unsupported"), true);

console.log("package manager execution boundary test ok");
