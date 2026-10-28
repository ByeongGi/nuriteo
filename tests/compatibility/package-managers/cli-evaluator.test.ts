import assert from "node:assert/strict";
import { createAsyncCliModuleEvaluator, createCliModuleEvaluator, createIsolatedAsyncCliModuleEvaluator, createWorkerBackedAsyncCliModuleEvaluator, MemoryPackageManagerWorkspace } from "../../../packages/node-runtime/src/index.ts";
import { FakeCliEvaluationWorker, workspace } from "./cli-evaluator-fixtures.ts";

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


const evaluateAsync = createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
});

const asyncVersion = await evaluateAsync({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/async-cli/package/bin/npm-cli.js"
  },
  args: ["--version"],
  cwd: "/workspace/project"
});

assert.equal(asyncVersion.stdout, "async-version\n");

assert.equal(asyncVersion.stderr, "");

assert.equal(asyncVersion.exitCode, 0);


const writeResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace,
  writer: workspace,
  settleTicks: 100,
  settleTimeoutMs: 10
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/write-cli/package/bin/npm-cli.js"
  },
  args: ["write"],
  cwd: "/workspace/project"
});

assert.equal(writeResult.stdout, "wrote true true\n", JSON.stringify(writeResult));

assert.equal(writeResult.stderr, "");

assert.equal(writeResult.exitCode, 0);

assert.equal(workspace.readText("/workspace/project/sync.txt"), "sync");

assert.equal(workspace.readText("/workspace/project/.cache/async.txt"), "async");

assert.equal(workspace.readText("/workspace/project/fd.txt"), "fd");

assert.equal(workspace.readText("/workspace/project/numeric-fd.txt"), "numeric");

assert.equal(workspace.exists("/workspace/project/delete-me.txt"), false);

assert.equal(workspace.exists("/workspace/project/delete-me-async.txt"), false);

assert.equal(workspace.exists("/workspace/project/delete-dir"), false);

assert.equal(workspace.exists("/workspace/project/delete-dir-async"), false);

assert.equal(workspace.exists("/workspace/project/rename-source.txt"), false);

assert.equal(workspace.readText("/workspace/project/rename-target.txt"), "renamed");

assert.equal(workspace.exists("/workspace/project/rename-source-async.txt"), false);

assert.equal(workspace.readText("/workspace/project/rename-target-async.txt"), "renamed-async");

assert.equal(workspace.readText("/workspace/project/copied.txt"), "renamed");

assert.equal(workspace.readText("/workspace/project/copied-async.txt"), "renamed-async");

assert.equal(workspace.readText("/workspace/project/linked-file.txt"), "renamed");

assert.equal(workspace.readText("/workspace/project/linked-file-async.txt"), "renamed-async");

assert.equal(workspace.readText("/workspace/project/linked-package/package.json"), '{"name":"linked-source"}');

assert.equal(workspace.readText("/workspace/project/linked-package-async/package.json"), '{"name":"linked-source"}');


const relativeResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace,
  writer: workspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/relative-cli/package/bin/npm-cli.js"
  },
  args: ["relative"],
  cwd: "/workspace/project"
});

assert.equal(relativeResult.stdout, "true:true:hello:true:true:number:true:true:true:hello:created:async-created\n");

assert.equal(relativeResult.stderr, "");

assert.equal(relativeResult.exitCode, 0);

assert.equal(workspace.readText("/workspace/project/created.txt"), "created");

assert.equal(workspace.readText("/workspace/project/created-async.txt"), "async-created");


const isolatedWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/write-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/write-cli/package/lib/cli.js",
    data: `
      const fs = require('fs');
      module.exports = function run(process) {
        fs.writeFileSync(process.cwd() + '/isolated.txt', 'isolated');
        process.stdout.write('isolated-write\\n');
      };
    `
  },
  {
    path: "/workspace/write-cli/package/package.json",
    data: JSON.stringify({ name: "isolated-write-cli", version: "1.2.3", main: "lib/cli.js" })
  }
]);

const isolatedResult = await createIsolatedAsyncCliModuleEvaluator({
  root: "/workspace",
  workspace: isolatedWorkspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/write-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(isolatedResult.stdout, "isolated-write\n");

assert.equal(isolatedResult.stderr, "");

assert.equal(isolatedResult.exitCode, 0);

assert.equal(isolatedWorkspace.exists("/workspace/project/isolated.txt"), false);

assert.equal(
  MemoryPackageManagerWorkspace.fromSnapshot(isolatedResult.workspaceSnapshot).readText("/workspace/project/isolated.txt"),
  "isolated"
);


const workerBackedWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/write-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/write-cli/package/lib/cli.js",
    data: `
      const fs = require('fs');
      module.exports = function run(process) {
        fs.writeFileSync(process.cwd() + '/worker-backed.txt', 'worker-backed');
        process.stdout.write('worker-backed-write\\n');
      };
    `
  },
  {
    path: "/workspace/write-cli/package/package.json",
    data: JSON.stringify({ name: "worker-backed-write-cli", version: "1.2.3", main: "lib/cli.js" })
  }
]);

const workerBackedResult = await createWorkerBackedAsyncCliModuleEvaluator({
  captureGlobalCalls: ["__fixtureRegister"],
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: workerBackedWorkspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/write-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(workerBackedResult.stdout, "worker-backed-write\n");

assert.equal(workerBackedResult.stderr, "");

assert.equal(workerBackedResult.exitCode, 0);

assert.equal(workerBackedWorkspace.exists("/workspace/project/worker-backed.txt"), false);

assert.equal(
  MemoryPackageManagerWorkspace.fromSnapshot(workerBackedResult.workspaceSnapshot).readText("/workspace/project/worker-backed.txt"),
  "worker-backed"
);

assert.deepEqual(workerBackedResult.capturedGlobalCalls, []);

await import("./cli-evaluator-cases.ts");
await import("./cli-evaluator-workers.ts");

console.log("package manager cli evaluator test ok");
