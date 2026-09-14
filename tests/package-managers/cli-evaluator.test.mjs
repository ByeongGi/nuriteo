import assert from "node:assert/strict";

import { createCliModuleEvaluator, createGuestRuntimeProcessRunner, createNpmRunner, MemoryPackageManagerWorkspace } from "../../packages/node-runtime/src/index.ts";

const workspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/cli/package/lib/cli.js",
    data: `
      const manifest = require('../package.json');
      module.exports = function run(process) {
        if (process.argv.includes('--version')) {
          process.stdout.write(manifest.version + '\\n');
          return;
        }
        process.stderr.write('unsupported command\\n');
        process.exit(7);
      };
    `
  },
  {
    path: "/workspace/cli/package/package.json",
    data: JSON.stringify({ name: "fixture-cli", version: "1.2.3", main: "lib/cli.js" })
  }
]);

const evaluate = createCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
});

const version = evaluate({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/cli/package/bin/npm-cli.js",
    entrySha256: "fixture"
  },
  args: ["--version"],
  cwd: "/workspace/project",
  env: { npm_config_user_agent: "fixture" }
});

assert.deepEqual(version, {
  stdout: "1.2.3\n",
  stderr: "",
  exitCode: 0,
  entry: "/workspace/cli/package/bin/npm-cli.js",
  entrySha256: "fixture"
});

const unsupported = evaluate({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/cli/package/bin/npm-cli.js"
  },
  args: ["install"],
  cwd: "/workspace/project"
});

assert.equal(unsupported.stdout, "");
assert.equal(unsupported.stderr, "unsupported command\n");
assert.equal(unsupported.exitCode, 7);

const entry = {
  name: "npm",
  version: "1.2.3",
  entry: "/workspace/cli/package/bin/npm-cli.js",
  entrySha256: "fixture"
};
const npm = createNpmRunner({
  registry: {
    resolve() {
      return entry;
    }
  },
  processRunner: createGuestRuntimeProcessRunner({
    artifacts: workspace,
    cliModuleEvaluation: {
      root: "/workspace",
      reader: workspace
    }
  })
});
const guestVersion = npm.version("/workspace/project");
assert.equal(guestVersion.runtime, "browser-guest-node-runtime");
assert.equal(guestVersion.bootMode, "cli-module-evaluation");
assert.equal(guestVersion.commandKind, "version");
assert.equal(guestVersion.stdout, "1.2.3\n");
assert.equal(guestVersion.stderr, "");
assert.equal(guestVersion.exitCode, 0);
assert.equal(guestVersion.entrySha256, "fixture");

console.log("package manager cli evaluator test ok");
