import assert from "node:assert/strict";

import {
  createWorkerBackedAsyncCliModuleEvaluator,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";
import { NodeThreadCliEvaluationWorker } from "../../../tooling/shared/node-thread-cli-worker.ts";

const workspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/nested-worker/bin/cli.cjs",
    data: `
      const { Worker } = require('node:worker_threads');
      const signal = new Int32Array(new SharedArrayBuffer(4));
      const worker = new Worker('/workspace/nested-worker/lib/child.cjs', {
        workerData: { signal }
      });
      const status = Atomics.wait(signal, 0, 0, 3000);
      process.stdout.write(status + ':' + Atomics.load(signal, 0) + '\\n');
      void worker.terminate();
    `
  },
  {
    path: "/workspace/nested-worker/lib/child.cjs",
    data: `
      const { workerData } = require('node:worker_threads');
      Atomics.store(workerData.signal, 0, 1);
      Atomics.notify(workerData.signal, 0);
    `
  },
  {
    path: "/workspace/nested-worker/package.json",
    data: JSON.stringify({ name: "nested-worker-isolate-fixture", version: "1.0.0" })
  }
]);

const result = await createWorkerBackedAsyncCliModuleEvaluator({
  root: "/workspace",
  workerFactory: () => new NodeThreadCliEvaluationWorker(),
  workerTimeoutMs: 5000,
  workspace
})({
  entry: {
    name: "nested-worker-isolate-fixture",
    version: "1.0.0",
    entry: "/workspace/nested-worker/bin/cli.cjs"
  },
  args: [],
  cwd: "/workspace/nested-worker"
});

assert.equal(result.exitCode, 0, result.stderr);
assert.equal(result.stdout, "ok:1\n");
assert.equal(result.stderr, "");
console.log("nested worker isolate test ok");
