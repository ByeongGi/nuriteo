import assert from "node:assert/strict";
import { classifyCliEntryModuleMode, createAsyncCliModuleEvaluator, createCliModuleEvaluator, createLoopbackNetwork, createIsolatedAsyncCliModuleEvaluator, createWorkerBackedAsyncCliModuleEvaluator, evaluateCliModuleWorkerMessage, inspectCliEntryReadiness, MemoryPackageManagerWorkspace } from "../../../packages/node-runtime/src/index.ts";
import { FakeCliEvaluationWorker, HangingBridgeCliEvaluationWorker, NonRespondingCliEvaluationWorker, workspace } from "./cli-evaluator-fixtures.ts";

const workerBackedRegistrationWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/register-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/register-cli/package/lib/cli.js",
    data: `
      module.exports = function run(process) {
        global.__fixtureRegister?.({
          command: 'dev',
          nested: { ok: true },
          invoke() { return 'not-serializable'; }
        });
        process.stdout.write('registered\\n');
      };
    `
  },
  {
    path: "/workspace/register-cli/package/package.json",
    data: JSON.stringify({ name: "worker-backed-register-cli", version: "1.2.3", main: "lib/cli.js" })
  }
]);

const workerBackedRegistrationResult = await createWorkerBackedAsyncCliModuleEvaluator({
  captureGlobalCalls: ["__fixtureRegister"],
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: workerBackedRegistrationWorkspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/register-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(workerBackedRegistrationResult.stdout, "registered\n");

assert.deepEqual(workerBackedRegistrationResult.capturedGlobalCalls, [
  {
    name: "__fixtureRegister",
    args: [
      {
        command: "dev",
        nested: { ok: true },
        invoke: { __cliFunctionRef: true }
      }
    ]
  }
]);


const workerBackedEsmBootstrapWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/vite/package/bin/vite.mjs",
    data: `
      import { performance } from 'node:perf_hooks';
      import module from 'node:module';
      global.__vite_start_time = performance.now();
      function start() {
        module.enableCompileCache?.();
        return import('../dist/node/cli.mjs');
      }
      if (process.argv.includes('--profile')) {
        // profile boot path remains outside the CSP-safe subset.
      } else {
        start();
      }
    `
  },
  {
    path: "/workspace/vite/package/dist/node/cli.mjs",
    data: `
      global.__fixtureRegister?.({
        command: 'dev',
        source: 'vite-cli',
        startedAt: global.__vite_start_time,
        invoke() { return 'not-serializable'; }
      });
    `
  },
  {
    path: "/workspace/vite/package/package.json",
    data: JSON.stringify({ name: "vite", version: "0.0.0-worker-bootstrap", type: "module", bin: { vite: "bin/vite.mjs" } })
  }
]);

const workerBackedEsmBootstrapResult = await createWorkerBackedAsyncCliModuleEvaluator({
  captureGlobalCalls: ["__fixtureRegister"],
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: workerBackedEsmBootstrapWorkspace
})({
  entry: {
    name: "vite",
    version: "0.0.0-worker-bootstrap",
    entry: "/workspace/vite/package/bin/vite.mjs"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(workerBackedEsmBootstrapResult.stderr, "");

assert.equal(workerBackedEsmBootstrapResult.exitCode, 0);

assert.equal(workerBackedEsmBootstrapResult.capturedGlobalCalls.length, 1);

assert.equal(workerBackedEsmBootstrapResult.capturedGlobalCalls[0].name, "__fixtureRegister");

assert.equal(workerBackedEsmBootstrapResult.capturedGlobalCalls[0].args[0].command, "dev");

assert.equal(workerBackedEsmBootstrapResult.capturedGlobalCalls[0].args[0].source, "vite-cli");

assert.equal(typeof workerBackedEsmBootstrapResult.capturedGlobalCalls[0].args[0].startedAt, "number");

assert.deepEqual(workerBackedEsmBootstrapResult.capturedGlobalCalls[0].args[0].invoke, { __cliFunctionRef: true });


const fileFetchWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/fetch/package/bin/fetch-wasm.mjs",
    data: `
      const wasmUrl = new globalThis.URL('./probe.wasm', import.meta.url).href;
      const response = await globalThis.fetch(wasmUrl);
      const bytes = new Uint8Array(await response.arrayBuffer());
      process.stdout.write(String(response.ok) + ':' + String(bytes.byteLength) + ':' + String(bytes[1]));
    `
  },
  {
    path: "/workspace/fetch/package/bin/probe.wasm",
    data: Buffer.from([0, 255, 1, 2]).toString("base64"),
    encoding: "base64"
  },
  {
    path: "/workspace/fetch/package/package.json",
    data: JSON.stringify({ name: "fetch-wasm", version: "1.0.0", type: "module", bin: { "fetch-wasm": "bin/fetch-wasm.mjs" } })
  }
]);

const fileFetchResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: fileFetchWorkspace
})({
  entry: {
    name: "fetch-wasm",
    version: "1.0.0",
    entry: "/workspace/fetch/package/bin/fetch-wasm.mjs",
    mode: "esm"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(fileFetchResult.stderr, "");

assert.equal(fileFetchResult.exitCode, 0);

assert.equal(fileFetchResult.stdout, "true:4:255");


const staticEsmWorkspace = new MemoryPackageManagerWorkspace([
  { path: "/workspace/static-esm/bin/main.mjs", data: "throw new Error('dynamic evaluation must not run');\n" },
  { path: "/workspace/static-esm/generated/config.mjs", data: "throw new Error('dynamic evaluation must not run');\n" }
]);

const staticEsmResult = await evaluateCliModuleWorkerMessage({
  id: 91,
  request: {
    entry: { name: "static-esm", version: "1.0.0", entry: "/workspace/static-esm/bin/main.mjs", mode: "esm" },
    args: [],
    cwd: "/workspace/static-esm"
  },
  root: "/workspace",
  type: "cli:evaluate",
  workspaceSnapshot: staticEsmWorkspace.snapshot()
}, {
  precompiledEsmFactories: {
    "/workspace/static-esm/bin/main.mjs": async (context) => {
      await context.dynamicImport("file:///workspace/static-esm/generated/config.mjs");
    },
    "/workspace/static-esm/generated/config.mjs": (_context, globals) => {
      globals.process.stdout.write("static-esm-file-url-ready");
    }
  }
});

assert.equal(staticEsmResult.error, undefined);

assert.equal(staticEsmResult.result?.exitCode, 0);

assert.equal(staticEsmResult.result?.stdout, "static-esm-file-url-ready");


const asyncRequireBridgeWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/async-require/package/bin/cli.cjs",
    data: `
      const binding = require('../lib/binding.mjs');
      setTimeout(() => {
        process.stdout.write(String(binding.label));
      }, 0);
    `
  },
  {
    path: "/workspace/async-require/package/lib/binding.mjs",
    data: "const value = await Promise.resolve('async-binding-ready');\nexport const label = value;\n"
  },
  {
    path: "/workspace/async-require/package/package.json",
    data: JSON.stringify({ name: "async-require", version: "1.0.0", bin: { "async-require": "bin/cli.cjs" } })
  }
]);

const asyncRequireBridgeResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: asyncRequireBridgeWorkspace,
  settleTicks: 2,
  settleTimeoutMs: 10
})({
  entry: {
    name: "async-require",
    version: "1.0.0",
    entry: "/workspace/async-require/package/bin/cli.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(asyncRequireBridgeResult.stderr, "");

assert.equal(asyncRequireBridgeResult.exitCode, 0);

assert.equal(asyncRequireBridgeResult.stdout, "async-binding-ready");


const asyncRequireConstructorBridgeWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/async-constructor/package/bin/cli.cjs",
    data: `
      const binding = require('../lib/binding.mjs');
      const callable = new binding.BindingCallableBuiltinPlugin({ name: 'builtin:test' });
      process.stdout.write(String(callable.getOrder('transform')) + ':' + typeof callable.close + ':' + typeof callable.scan + ':' + typeof callable.write);
      callable.write().then((result) => process.stdout.write(':' + Array.isArray(result.chunks) + ':' + Array.isArray(result.assets)));
    `
  },
  {
    path: "/workspace/async-constructor/package/lib/binding.mjs",
    data: "await Promise.resolve();\nexport class BindingCallableBuiltinPlugin {\n  getOrder() { return 'post'; }\n}\n"
  },
  {
    path: "/workspace/async-constructor/package/package.json",
    data: JSON.stringify({ name: "async-constructor", version: "1.0.0", bin: { "async-constructor": "bin/cli.cjs" } })
  }
]);

const asyncRequireConstructorBridgeResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: asyncRequireConstructorBridgeWorkspace,
  settleTicks: 2,
  settleTimeoutMs: 10
})({
  entry: {
    name: "async-constructor",
    version: "1.0.0",
    entry: "/workspace/async-constructor/package/bin/cli.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(asyncRequireConstructorBridgeResult.stderr, "");

assert.equal(asyncRequireConstructorBridgeResult.exitCode, 0);

assert.equal(asyncRequireConstructorBridgeResult.stdout, "undefined:function:function:function:true:true");


const asyncRequireBundlerBridgeWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/async-bundler/package/bin/cli.cjs",
    data: `
      const binding = require('../lib/binding.mjs');
      const bundler = new binding.BindingBundler();
      Promise.all([bundler.generate(), bundler.write()]).then(([generated, written]) => {
        process.stdout.write([
          Array.isArray(generated.chunks),
          Array.isArray(generated.assets),
          Array.isArray(written.chunks),
          Array.isArray(written.assets)
        ].join(':'));
      });
    `
  },
  {
    path: "/workspace/async-bundler/package/lib/binding.mjs",
    data: "await Promise.resolve();\nexport class BindingBundler {}\n"
  },
  {
    path: "/workspace/async-bundler/package/package.json",
    data: JSON.stringify({ name: "async-bundler", version: "1.0.0", bin: { "async-bundler": "bin/cli.cjs" } })
  }
]);

const asyncRequireBundlerBridgeResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: asyncRequireBundlerBridgeWorkspace,
  settleTicks: 2,
  settleTimeoutMs: 10
})({
  entry: {
    name: "async-bundler",
    version: "1.0.0",
    entry: "/workspace/async-bundler/package/bin/cli.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(asyncRequireBundlerBridgeResult.stderr, "");

assert.equal(asyncRequireBundlerBridgeResult.exitCode, 0);

assert.equal(asyncRequireBundlerBridgeResult.stdout, "true:true:true:true");


const asyncRequireBundlerWriteWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/project/index.html",
    data: '<div id="root"></div><script type="module" src="/src/main.ts"></script>\n'
  },
  {
    path: "/workspace/project/src/main.ts",
    data: "const value: number = 1;\ndocument.body.textContent = String(value);\n"
  },
  {
    path: "/workspace/async-bundler-write/package/bin/cli.cjs",
    data: `
      const binding = require('../lib/binding.mjs');
      const bundler = new binding.BindingBundler();
      bundler.write({
        inputOptions: { cwd: '/workspace/project', input: [{ import: '/workspace/project/index.html' }] },
        outputOptions: { dir: '/workspace/project/dist' }
      }).then((result) => process.stdout.write(String(result.chunks.length) + ':' + String(result.assets.length)));
    `
  },
  {
    path: "/workspace/async-bundler-write/package/lib/binding.mjs",
    data: "await Promise.resolve();\nexport class BindingBundler {}\n"
  },
  {
    path: "/workspace/async-bundler-write/package/package.json",
    data: JSON.stringify({ name: "async-bundler-write", version: "1.0.0", bin: { "async-bundler-write": "bin/cli.cjs" } })
  }
]);

const asyncRequireBundlerWriteResult = await createIsolatedAsyncCliModuleEvaluator({
  root: "/workspace",
  workspace: asyncRequireBundlerWriteWorkspace,
  settleTicks: 2,
  settleTimeoutMs: 10
})({
  entry: {
    name: "async-bundler-write",
    version: "1.0.0",
    entry: "/workspace/async-bundler-write/package/bin/cli.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(asyncRequireBundlerWriteResult.stderr, "");

assert.equal(asyncRequireBundlerWriteResult.exitCode, 0);

assert.equal(asyncRequireBundlerWriteResult.stdout, "1:1");

const bundlerWriteFiles = new Map(asyncRequireBundlerWriteResult.workspaceSnapshot.files.map((file) => [file.path, Buffer.from(file.data, "base64").toString("utf8")]));

assert.match(bundlerWriteFiles.get("/workspace/project/dist/index.html"), /assets\/index\.js/);

assert.equal(bundlerWriteFiles.get("/workspace/project/dist/assets/index.js")?.includes("const value = 1;"), true);


const httpServerBridgeWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/http-server/package/bin/server.cjs",
    data: `
      const http = require('node:http');
      const server = http.createServer((request, response) => {
        response.setHeader('x-cli-server', 'loopback');
        response.appendHeader('x-cli-values', 'one');
        response.appendHeader('x-cli-values', ['two', 'three']);
        response.end('served:' + request.method + ':' + request.url);
      });
      server.listen(6123, '127.0.0.1', () => process.stdout.write('listening'));
    `
  },
  {
    path: "/workspace/http-server/package/package.json",
    data: JSON.stringify({ name: "http-server", version: "1.0.0", bin: { "http-server": "bin/server.cjs" } })
  }
]);

const httpServerNetwork = createLoopbackNetwork();

const httpServerBridgeResult = await createAsyncCliModuleEvaluator({
  loopbackNetwork: httpServerNetwork,
  root: "/workspace",
  reader: httpServerBridgeWorkspace,
  settleTicks: 2,
  settleTimeoutMs: 10
})({
  entry: {
    name: "http-server",
    version: "1.0.0",
    entry: "/workspace/http-server/package/bin/server.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(httpServerBridgeResult.stderr, "");

assert.equal(httpServerBridgeResult.exitCode, 0);

assert.equal(httpServerBridgeResult.stdout, "listening");

const httpServerResponse = await httpServerNetwork.fetch("http://127.0.0.1:6123/src/main.js", { method: "POST", body: "body" });

assert.equal(httpServerResponse.statusCode, 200);

assert.equal(httpServerResponse.headers?.["x-cli-server"], "loopback");

assert.equal(httpServerResponse.headers?.["x-cli-values"], "one, two, three");

assert.equal(httpServerResponse.body, "served:POST:/src/main.js");


const workerHttpServerNetwork = createLoopbackNetwork();

const workerHttpServerResult = await createWorkerBackedAsyncCliModuleEvaluator({
  loopbackNetwork: workerHttpServerNetwork,
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: httpServerBridgeWorkspace
})({
  entry: {
    name: "http-server",
    version: "1.0.0",
    entry: "/workspace/http-server/package/bin/server.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(workerHttpServerResult.stderr, "");

assert.equal(workerHttpServerResult.exitCode, 0);

assert.deepEqual(workerHttpServerResult.bridgedServerPorts, [6123]);

const workerHttpServerResponse = await workerHttpServerNetwork.fetch("http://127.0.0.1:6123/worker.js", { method: "PUT", body: "worker-body" });

assert.equal(workerHttpServerResponse.statusCode, 200);

assert.equal(workerHttpServerResponse.headers?.["x-cli-server"], "loopback");

assert.equal(workerHttpServerResponse.body, "served:PUT:/worker.js");

workerHttpServerResult.closeBridgedServers?.();

await assert.rejects(
  workerHttpServerNetwork.fetch("http://127.0.0.1:6123/worker.js"),
  (error) => error.code === "ECONNREFUSED"
);


const viteClientBridgeWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/vite-client-bridge/package/bin/server.cjs",
    data: `
      const http = require('node:http');
      http.createServer((request, response) => {
        if (request.url === '/@fs//workspace/project/node_modules/vite/dist/client/client.mjs') {
          response.setHeader('content-type', 'text/javascript');
          response.end('export const createHotContext = () => ({ accept() {} });');
          return;
        }
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('');
      }).listen(6124, '127.0.0.1', () => process.stdout.write('listening'));
    `
  },
  {
    path: "/workspace/vite-client-bridge/package/package.json",
    data: JSON.stringify({ name: "vite-client-bridge", version: "1.0.0", bin: { "vite-client-bridge": "bin/server.cjs" } })
  }
]);

const viteClientBridgeNetwork = createLoopbackNetwork();

const viteClientBridgeResult = await createWorkerBackedAsyncCliModuleEvaluator({
  loopbackNetwork: viteClientBridgeNetwork,
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: viteClientBridgeWorkspace
})({
  entry: {
    name: "vite-client-bridge",
    version: "1.0.0",
    entry: "/workspace/vite-client-bridge/package/bin/server.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(viteClientBridgeResult.exitCode, 0);

const viteClientBridgeResponse = await viteClientBridgeNetwork.fetch("http://127.0.0.1:6124/@vite/client", {
  headers: { "sec-fetch-dest": "script" }
});

assert.equal(viteClientBridgeResponse.statusCode, 200);

assert.match(viteClientBridgeResponse.body, /createHotContext/);

viteClientBridgeResult.closeBridgedServers?.();


const pendingCliWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/pending/package/bin/pending.mjs",
    data: "await new Promise(() => {});\n"
  },
  {
    path: "/workspace/pending/package/package.json",
    data: JSON.stringify({ name: "pending-cli", version: "1.2.3", type: "module", bin: { pending: "bin/pending.mjs" } })
  }
]);

const pendingCliResult = await createAsyncCliModuleEvaluator({
  readyTimeoutMs: 5,
  root: "/workspace",
  reader: pendingCliWorkspace,
  settleTimeoutMs: 1
})({
  entry: {
    name: "pending",
    version: "1.2.3",
    entry: "/workspace/pending/package/bin/pending.mjs",
    mode: "esm"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(pendingCliResult.exitCode, 1);

assert.match(pendingCliResult.stderr, /ECLIETIMEOUT/);


const workerBackedPendingCliResult = await createWorkerBackedAsyncCliModuleEvaluator({
  readyTimeoutMs: 5,
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: pendingCliWorkspace
})({
  entry: {
    name: "pending",
    version: "1.2.3",
    entry: "/workspace/pending/package/bin/pending.mjs",
    mode: "esm"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(workerBackedPendingCliResult.exitCode, 1);

assert.match(workerBackedPendingCliResult.stderr, /ECLIETIMEOUT/);


const nonRespondingWorker = new NonRespondingCliEvaluationWorker();

await assert.rejects(
  () => createWorkerBackedAsyncCliModuleEvaluator({
    root: "/workspace",
    workerFactory: () => nonRespondingWorker,
    workerTimeoutMs: 5,
    workspace: pendingCliWorkspace
  })({
    entry: {
      name: "pending",
      version: "1.2.3",
      entry: "/workspace/pending/package/bin/pending.mjs",
      mode: "esm"
    },
    args: [],
    cwd: "/workspace/project"
  }),
  /ECLIEWORKERTIMEOUT/
);

assert.equal(nonRespondingWorker.terminated, true);


const hangingBridgeWorker = new HangingBridgeCliEvaluationWorker();

const hangingBridgeNetwork = createLoopbackNetwork();

const hangingBridgeResult = await createWorkerBackedAsyncCliModuleEvaluator({
  loopbackNetwork: hangingBridgeNetwork,
  root: "/workspace",
  workerFactory: () => hangingBridgeWorker,
  workerTimeoutMs: 100,
  workspace: pendingCliWorkspace
})({
  entry: {
    name: "pending",
    version: "1.2.3",
    entry: "/workspace/pending/package/bin/pending.mjs",
    mode: "esm"
  },
  args: [],
  cwd: "/workspace/project"
});

const hangingHttpRequest = hangingBridgeNetwork.fetch("http://127.0.0.1:6125/");

const hangingFsWrite = hangingBridgeResult.writeBridgedFile("/workspace/project/src/main.ts", "updated");

await Promise.resolve();

hangingBridgeResult.closeBridgedServers();

await assert.rejects(hangingHttpRequest, /ECLIBRIDGECLOSED/);

await assert.rejects(hangingFsWrite, /ECLIBRIDGECLOSED/);

assert.equal(hangingBridgeWorker.terminated, true);

assert.equal(hangingBridgeNetwork.listeners.size, 0);

await assert.rejects(
  () => hangingBridgeResult.writeBridgedFile("/workspace/project/src/main.ts", "late write"),
  /ECLIBRIDGECLOSED/
);


const crashWorker = new HangingBridgeCliEvaluationWorker();

const crashNetwork = createLoopbackNetwork();

const crashResult = await createWorkerBackedAsyncCliModuleEvaluator({
  loopbackNetwork: crashNetwork,
  root: "/workspace",
  workerFactory: () => crashWorker,
  workspace: pendingCliWorkspace
})({
  entry: { name: "pending", version: "1.2.3", entry: "/workspace/pending/package/bin/pending.mjs", mode: "esm" },
  args: [],
  cwd: "/workspace/project"
});

const interruptedHttp = crashNetwork.fetch("http://127.0.0.1:6125/");

const interruptedWrite = crashResult.writeBridgedFile("/workspace/project/src/main.ts", "update");

await Promise.resolve();

crashWorker.emitError("worker heap limit");

await assert.rejects(interruptedHttp, /ECLIBRIDGECLOSED/);

await assert.rejects(interruptedWrite, /ECLIBRIDGECLOSED/);

assert.equal(crashNetwork.listeners.size, 0);

assert.equal(crashWorker.terminated, true);


const asyncErrorResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace,
  settleTicks: 10,
  settleTimeoutMs: 10
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/async-error-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(asyncErrorResult.stdout, "");

assert.match(asyncErrorResult.stderr, /delayed failure/);

assert.equal(asyncErrorResult.exitCode, 1);


const asyncExitResult = await createAsyncCliModuleEvaluator({
  exitTimeoutMs: 100,
  root: "/workspace",
  reader: workspace,
  waitForExit: true
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/async-exit-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(asyncExitResult.stdout, "finished\n");

assert.equal(asyncExitResult.stderr, "");

assert.equal(asyncExitResult.exitCode, 0);


let readTimerOutput = () => ({ stderr: "", stdout: "" });

const timerResult = await createAsyncCliModuleEvaluator({
  onOutputSnapshot(snapshot) {
    readTimerOutput = snapshot;
  },
  root: "/workspace",
  reader: workspace,
  settleTimeoutMs: 5
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/timer-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(typeof timerResult.dispose, "function");

timerResult.dispose();

const timerOutputAfterDispose = readTimerOutput().stdout;

await new Promise((resolve) => setTimeout(resolve, 10));

assert.equal(readTimerOutput().stdout, timerOutputAfterDispose);


const errorCauseResult = createCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/error-cause-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(errorCauseResult.stdout, "");

assert.match(errorCauseResult.stderr, /top failure/);

assert.match(errorCauseResult.stderr, /Caused by:/);

assert.match(errorCauseResult.stderr, /nested native binding failure/);

assert.equal(errorCauseResult.exitCode, 1);


const globalResult = createCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/global-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(globalResult.stdout, "function true ok true true true object ok\n");

assert.equal(globalResult.stderr, "");

assert.equal(globalResult.exitCode, 0);


const workerResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace,
  settleTicks: 10,
  settleTimeoutMs: 10
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/worker-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});

assert.equal(workerResult.stdout, "false:wasi:true:object:true\n");

assert.equal(workerResult.stderr, "");

assert.equal(workerResult.exitCode, 0);


const esmCliEntry = {
  name: "vite",
  version: "1.2.3",
  entry: "/workspace/esm-cli/package/bin/vite.js"
};

assert.equal(classifyCliEntryModuleMode({ entry: esmCliEntry, reader: workspace }), "esm");

assert.deepEqual(inspectCliEntryReadiness({ entry: esmCliEntry, reader: workspace }), {
  status: "blocked",
  entry: "/workspace/esm-cli/package/bin/vite.js",
  mode: "esm",
  reasons: [
    {
      code: "ERR_CLI_ESM_ENTRY_UNSUPPORTED",
      message: "ESM CLI entrypoint requires async module entry execution: /workspace/esm-cli/package/bin/vite.js"
    }
  ],
  nextAction: "Add async ESM CLI entry execution before routing this command through the browser guest runtime."
});

assert.equal(inspectCliEntryReadiness({ entry: esmCliEntry, reader: workspace, supportedModes: ["cjs", "esm"] }).status, "ready");

const esmResult = createCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
})({
  entry: esmCliEntry,
  args: ["--host", "127.0.0.1"],
  cwd: "/workspace/project"
});

assert.equal(esmResult.stdout, "");

assert.match(esmResult.stderr, /ERR_CLI_ESM_ENTRY_UNSUPPORTED/);

assert.equal(esmResult.exitCode, 1);

const asyncEsmResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
})({
  entry: esmCliEntry,
  args: ["--host", "127.0.0.1"],
  cwd: "/workspace/project"
});

assert.equal(asyncEsmResult.stdout, "vite esm boot class boot star star createRequire 1.2.3 true mark\n");

assert.equal(asyncEsmResult.stderr, "");

assert.equal(asyncEsmResult.exitCode, 0);


const bundleProcessResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
})({
  entry: {
    name: "vite",
    version: "1.2.3",
    entry: "/workspace/bundle-process-cli/package/bin/vite.js"
  },
  args: ["--host", "127.0.0.1"],
  cwd: "/workspace/project"
});

assert.equal(bundleProcessResult.stdout, "/workspace/project|/workspace/project|function\n");

assert.equal(bundleProcessResult.stderr, "");

assert.equal(bundleProcessResult.exitCode, 0);
