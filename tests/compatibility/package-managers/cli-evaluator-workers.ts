import assert from "node:assert/strict";
import { createAsyncCliModuleEvaluator, createGuestRuntimeProcessRunner, createNpmRunner } from "../../../packages/node-runtime/src/index.ts";
import { workspace } from "./cli-evaluator-fixtures.ts";

const unawaitedDynamicResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace,
  settleTicks: 10
})({
  entry: {
    name: "vite",
    version: "1.2.3",
    entry: "/workspace/unawaited-dynamic-cli/package/bin/vite.js"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(unawaitedDynamicResult.stdout, "");

assert.match(unawaitedDynamicResult.stderr, /ERR_MODULE_NOT_FOUND/);

assert.equal(unawaitedDynamicResult.exitCode, 1);


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
