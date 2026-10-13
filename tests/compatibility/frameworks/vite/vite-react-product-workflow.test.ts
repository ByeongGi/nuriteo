import assert from "node:assert/strict";

import {
  applyNpmInstallPlan,
  applyPnpmStorePlan,
  createLoopbackNetwork,
  createCliEvaluationHttpBridge,
  createNpmInstallPlan,
  createPnpmStorePlan,
  createViteDependencyArtifactClosureFromWorkspace,
  createViteDependencyArtifactFromWorkspace,
  createViteDependencyArtifactsFromPlan,
  createViteDependencyArtifactsFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  createWasmAdapterPolicy,
  evaluateCliModuleWorkerMessage,
  MemoryPackageManagerWorkspace,
  mergeViteDependencyArtifacts,
  runViteProductCliBackedWorkflow,
  runViteProductWorkflow,
  ViteProductWorkflow
} from "../../../../packages/node-runtime/src/index.ts";
import { createHmrClient, createPreviewRelay, createPreviewSessionRegistry } from "../../../../packages/preview/src/index.ts";

class FakeCliEvaluationWorker {
  messages = [];

  #listeners = {
    message: new Set(),
    error: new Set()
  };
  #httpBridges = new Map();
  #terminated = false;

  addEventListener(type, listener) {
    this.#listeners[type].add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners[type].delete(listener);
  }

  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(async () => {
      if (this.#terminated) return;
      try {
        if (message.type === "cli:http:request") {
          const bridge = this.#httpBridges.get(message.evaluationId);
          if (!bridge) throw new Error(`missing CLI HTTP bridge: ${message.evaluationId}`);
          const response = {
            evaluationId: message.evaluationId,
            id: message.id,
            response: await bridge.handleRequest(message.port, message.request),
            type: "cli:http:response"
          };
          for (const listener of this.#listeners.message) listener({ data: response });
          return;
        }
        const bridge = message.bridgeLoopbackServer ? createCliEvaluationHttpBridge() : null;
        const response = await evaluateCliModuleWorkerMessage(message, bridge ? { httpBridge: bridge } : {});
        if (bridge && response.result?.bridgedServerPorts?.length) this.#httpBridges.set(message.id, bridge);
        for (const listener of this.#listeners.message) listener({ data: response });
      } catch (error) {
        for (const listener of this.#listeners.error) listener({ message: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  terminate() {
    this.#terminated = true;
    this.#listeners.message.clear();
    this.#listeners.error.clear();
  }
}

for (const template of ["react", "vue-runtime", "svelte"]) {
for (const manager of ["npm", "pnpm"]) {
  const result = runViteProductWorkflow({ manager, template });

  assert.equal(result.runtime, "browser-guest-node-runtime");
  assert.equal(result.manager, manager);
  assert.equal(result.template, template);
  assert.equal(result.install.installed, true);
  assert.equal(result.install.packages.includes("vite"), true);
  assert.equal(result.install.packages.includes(expectedFrameworkPackage(template)), true);
  assert.equal(result.install.vitePackageSource, "stub");
  assert.equal(result.realCliReadiness.status, "blocked");
  assert.equal(result.realCliReadiness.vitePackageSource, "stub");
  assert.equal(result.realCliReadiness.cliEntrypoint, "/workspace/project/node_modules/vite/bin/vite.js");
  assert.equal(result.realCliReadiness.cliEntryReadiness.status, "ready");
  assert.equal(result.realCliReadiness.cliEntryReadiness.mode, "esm");
  assert.deepEqual(result.realCliReadiness.cliEntryReadiness.reasons, []);
  assert.equal(result.realCliReadiness.cliModuleGraph.entry, "/workspace/project/node_modules/vite/bin/vite.js");
  assert.deepEqual(result.realCliReadiness.cliModuleGraph.modules[0].imports, ["../dist/node/cli.js"]);
  assert.equal(
    result.realCliReadiness.cliModuleGraph.modules.some((mod) => mod.path.endsWith("/dist/node/cli.js")),
    true
  );
  assert.equal(
    result.realCliReadiness.cliModuleGraph.modules.some((mod) => mod.path.endsWith("/dist/node/server.js")),
    true
  );
  assert.equal(
    result.realCliReadiness.cliModuleGraph.modules.some((mod) => mod.path.endsWith("/dist/node/hmr.js")),
    true
  );
  assert.deepEqual(result.realCliReadiness.cliModuleGraph.issues, []);
  assert.equal(result.realCliReadiness.cliModuleGraph.supported, true);
  assert.deepEqual(
    result.realCliReadiness.capabilityStatus.filter((capability) => capability.status === "ready").map((capability) => capability.capability),
    ["esm-cli-entrypoint", "minimal-vite-cli-module-graph", "cli-registration-hooks", "cli-backed-dev-build-workflow"]
  );
  assert.equal(result.realCliReadiness.capabilityStatus.some((capability) => capability.capability === "mounted-vite-artifact-input"), false);
  assert.deepEqual(
    result.realCliReadiness.capabilityStatus.filter((capability) => capability.status === "blocked").map((capability) => capability.capability),
    result.realCliReadiness.missingCapabilities
  );
  assert.equal(result.realCliReadiness.missingCapabilities.includes("actual-vite-cli-module-execution"), true);
  assert.equal(result.realCliReadiness.missingCapabilities.includes("real-vite-hmr-protocol"), true);
  assert.equal(
    result.realCliReadiness.missingCapabilities.includes("framework-plugin-module-execution"),
    template !== "react"
  );
  assert.equal(result.devServer.running, true);
  assert.equal(result.devServer.source, "package-script");
  assert.equal(result.devServer.command, "vite --host 127.0.0.1");
  assert.equal(result.devServer.cliEntrypoint, "/workspace/project/node_modules/vite/bin/vite.js");
  assert.equal(result.devServer.processPid, 5173);
  assert.equal(result.devServer.processStarted, true);
  assert.equal(result.devServer.processExited, false);
  assert.equal(result.preview.statusCode, 200);
  assert.match(result.preview.body, /alpha:1/);
  assert.match(result.hmr.before, /alpha:1/);
  assert.match(result.hmr.after, /beta:1/);
  assert.equal(result.hmr.statePreserved, true);
  assert.equal(result.build.files.includes("dist/index.html"), true);
  assert.match(result.build.distSmoke, /beta:1/);
  assert.equal(result.build.command, "vite build");
  assert.equal(result.build.cliEntrypoint, "/workspace/project/node_modules/vite/bin/vite.js");
  assert.equal(result.reloadRecovery.restarted, true);
  assert.match(result.reloadRecovery.previewAfterRestart, /beta:1/);

  const cliBacked = await runViteProductCliBackedWorkflow({ manager, template, port: 5190 });
  assert.equal(cliBacked.devServer.source, "cli-execution");
  assert.equal(cliBacked.devServer.moduleTransform, "vite-cli");
  assert.equal(cliBacked.devServer.processPid, 5190);
  assert.match(cliBacked.preview.body, /alpha:1/);
  assert.equal(cliBacked.hmr.statePreserved, true);
  assert.equal(cliBacked.build.command, "vite build");
  assert.match(cliBacked.build.distSmoke, /beta:1/);
  assert.match(cliBacked.reloadRecovery.previewAfterRestart, /beta:1/);

  const network = createLoopbackNetwork();
  const workflow = new ViteProductWorkflow({ manager, template, projectId: `${manager}-${template}-preview`, network, port: 5173 });
  workflow.install();
  const cliExecution = await workflow.executeRealCli(["--host", "127.0.0.1"]);
  assert.equal(cliExecution.mode, "async-cli-module-evaluation");
  assert.deepEqual(cliExecution.args, ["--host", "127.0.0.1"]);
  assert.equal(cliExecution.cwd, "/workspace/project");
  assert.equal(cliExecution.entry, "/workspace/project/node_modules/vite/bin/vite.js");
  assert.equal(cliExecution.stdout, "");
  assert.equal(cliExecution.stderr, "");
  assert.equal(cliExecution.exitCode, 0);
  assert.deepEqual(cliExecution.serverRegistrations, [
    {
      command: "dev",
      host: "127.0.0.1",
      port: 5173,
      source: "vite-cli"
    }
  ]);
  assert.deepEqual(cliExecution.hmrRegistrations.map(({ channel, source, transport }) => ({ channel, source, transport })), [
    {
      channel: "hmr",
      source: "vite-cli",
      transport: "loopback"
    }
  ]);
  assert.equal(typeof cliExecution.hmrRegistrations[0].sendUpdate, "function");
  assert.deepEqual(cliExecution.transformRegistrations.map(({ mode, source }) => ({ mode, source })), [
    {
      mode: "browser-esm",
      source: "vite-cli"
    }
  ]);
  assert.equal(typeof cliExecution.transformRegistrations[0].transformRequest, "function");
  assert.deepEqual(cliExecution.buildRegistrations, []);
  const cliBuildExecution = await workflow.executeRealCli(["build"]);
  assert.deepEqual(cliBuildExecution.serverRegistrations, []);
  assert.deepEqual(cliBuildExecution.hmrRegistrations, []);
  assert.deepEqual(cliBuildExecution.transformRegistrations, []);
  assert.deepEqual(cliBuildExecution.buildRegistrations, [
    {
      command: "build",
      outDir: "dist",
      source: "vite-cli"
    }
  ]);
  const cliBuild = await workflow.buildFromCliExecution();
  assert.equal(cliBuild.command, "vite build");
  assert.equal(cliBuild.cliEntrypoint, "/workspace/project/node_modules/vite/bin/vite.js");
  assert.equal(cliBuild.files.includes("dist/index.html"), true);
  const cliNetwork = createLoopbackNetwork();
  const cliWorkflow = new ViteProductWorkflow({ manager, template, projectId: `${manager}-${template}-cli`, network: cliNetwork, port: 5180 });
  cliWorkflow.install();
  const cliStarted = await cliWorkflow.startDevServerFromCliExecution();
  assert.equal(cliStarted.running, true);
  assert.equal(cliStarted.source, "cli-execution");
  assert.equal(cliStarted.moduleTransform, "vite-cli");
  assert.equal(cliStarted.command, "vite --host 127.0.0.1");
  assert.equal(cliStarted.cliEntrypoint, "/workspace/project/node_modules/vite/bin/vite.js");
  assert.equal(cliStarted.port, 5180);
  assert.equal(cliStarted.processPid, 5180);
  const cliPreview = await cliWorkflow.fetch("http://127.0.0.1:5180/index.html");
  assert.equal(cliPreview.status, 200);
  assert.match(await cliPreview.text(), /alpha:1/);
  const cliEntryModule = await cliWorkflow.fetch(`http://127.0.0.1:5180/${entryPathForTemplate(template)}`);
  assert.match(await cliEntryModule.text(), /transformed by vite-cli service:\/src\/main/);
  const httpServerArtifactWorkflow = new ViteProductWorkflow({
    manager,
    template,
    projectId: `${manager}-${template}-http-cli`,
    network: createLoopbackNetwork(),
    port: 5304,
    vitePackageArtifact: {
      version: "9.0.0-http-server",
      mounts: [
        {
          path: "package.json",
          data: JSON.stringify({ name: "vite", version: "9.0.0-http-server", type: "module", bin: { vite: "bin/vite.mjs" } })
        },
        {
          path: "bin/vite.mjs",
          data: "import '../dist/node/cli.mjs';\n"
        },
        {
          path: "dist/node/cli.mjs",
          data: "import http from 'node:http';\nconst port = Number(process.env.PORT || 5173);\nhttp.createServer((request, response) => {\n  response.setHeader('content-type', 'text/plain');\n  response.end('actual-server:' + request.url);\n}).listen(port, '127.0.0.1', () => process.stdout.write(`  VITE v9.0.0 ready\\n\\n  ➜  Local:   http://127.0.0.1:${port}/\\n`));\n"
        }
      ]
    }
  });
  httpServerArtifactWorkflow.install();
  const httpServerStarted = await httpServerArtifactWorkflow.startDevServerFromCliExecution();
  assert.equal(httpServerStarted.running, true);
  assert.equal(httpServerStarted.source, "cli-execution");
  assert.equal(httpServerStarted.moduleTransform, "vite-cli");
  assert.equal(httpServerStarted.port, 5304);
  assert.equal(httpServerStarted.processPid, null);
  const httpServerPreview = await httpServerArtifactWorkflow.fetch("http://127.0.0.1:5304/index.html");
  assert.equal(httpServerPreview.status, 200);
  assert.equal(await httpServerPreview.text(), "actual-server:/index.html");
  const workerHttpServerNetwork = createLoopbackNetwork();
  const workerHttpServerArtifactWorkflow = new ViteProductWorkflow({
    manager,
    template,
    projectId: `${manager}-${template}-worker-http-cli`,
    network: workerHttpServerNetwork,
    port: 5305,
    vitePackageArtifact: {
      version: "9.0.0-worker-http-server",
      mounts: httpServerArtifactWorkflow.vitePackageArtifact.mounts
    }
  });
  workerHttpServerArtifactWorkflow.install();
  const workerHttpServerStarted = await workerHttpServerArtifactWorkflow.startDevServerFromCliExecution("dev", {
    isolation: "worker",
    workerFactory: () => new FakeCliEvaluationWorker()
  });
  assert.equal(workerHttpServerStarted.running, true);
  assert.equal(workerHttpServerStarted.source, "cli-execution");
  assert.equal(workerHttpServerStarted.moduleTransform, "vite-cli");
  assert.equal(workerHttpServerStarted.port, 5305);
  const workerHttpServerPreview = await workerHttpServerArtifactWorkflow.fetch("http://127.0.0.1:5305/worker-index.html");
  assert.equal(workerHttpServerPreview.status, 200);
  assert.equal(await workerHttpServerPreview.text(), "actual-server:/worker-index.html");
  const cliHmrEvents = [];
  const cliHmr = createHmrClient({
    connect() {
      return cliWorkflow.connectHmr();
    }
  });
  cliHmr.on("message", (event) => cliHmrEvents.push(event.type));
  cliHmr.start();
  await Promise.resolve();
  cliWorkflow.applySourceEdit("src/message.js", "export const label = \"epsilon\";\n");
  cliHmr.close();
  assert.deepEqual(cliHmrEvents, ["connected", "update"]);
  const started = workflow.startDevServerFromPackageScript();
  assert.equal(started.running, true);
  assert.equal(started.port, 5173);
  assert.equal(started.source, "package-script");
  assert.equal(started.moduleTransform, "adapter");
  assert.equal(started.command, "vite --host 127.0.0.1");
  assert.equal(started.cliEntrypoint, "/workspace/project/node_modules/vite/bin/vite.js");
  assert.equal(started.processPid, 5173);
  assert.equal(started.processStarted, true);
  assert.equal(started.processExited, false);
  const conflict = new ViteProductWorkflow({ manager, template, projectId: `${manager}-${template}-conflict`, network, port: 5173 });
  conflict.install();
  assert.throws(
    () => conflict.startDevServer(),
    (error) => error.code === "EADDRINUSE"
  );
  const sessions = createPreviewSessionRegistry({ ttlMs: 1000 });
  const session = sessions.create({
    origin: "https://preview.local",
    projectId: `${manager}-${template}-preview`,
    port: 5173,
    container: workflow
  });
  const relay = createPreviewRelay({ sessions, timeoutMs: 100 });
  const response = await relay.request({
    sessionId: session.sessionId,
    origin: "https://preview.local",
    projectId: `${manager}-${template}-preview`,
    path: "/index.html"
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /alpha:1/);
  assert.deepEqual(workflow.startDevServer().requests, ["/index.html"]);
  const viteClient = await workflow.fetch("http://127.0.0.1:5173/@vite/client");
  assert.equal(viteClient.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await viteClient.text(), /createHotContext/);
  const entryModule = await workflow.fetch(`http://127.0.0.1:5173/${entryPathForTemplate(template)}`);
  assert.equal(entryModule.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await entryModule.text(), /message\.js|App\.svelte/);
  const styleModule = await workflow.fetch("http://127.0.0.1:5173/src/style.css");
  assert.equal(styleModule.headers.get("content-type"), "text/css; charset=utf-8");

  const stopped = workflow.stopDevServer();
  assert.equal(stopped.running, false);
  assert.equal(stopped.processExited, true);
  await assert.rejects(
    workflow.fetch("http://127.0.0.1:5173/index.html"),
    (error) => error.code === "ECONNREFUSED"
  );
  const restarted = workflow.startDevServer();
  assert.equal(restarted.running, true);
  assert.equal(restarted.processStarted, true);
  assert.equal(restarted.processExited, false);
  const recovered = await workflow.fetch("http://127.0.0.1:5173/index.html");
  assert.equal(recovered.status, 200);
  assert.match(await recovered.text(), /alpha:1/);

  const hmrEvents = [];
  const hmr = createHmrClient({
    connect() {
      return workflow.connectHmr();
    }
  });
  hmr.on("open", (event) => hmrEvents.push(`open:${event.attempt}`));
  hmr.on("message", (event) => hmrEvents.push(`message:${event.type}`));
  hmr.start();
  await Promise.resolve();
  workflow.editMessage("gamma");
  const editedMessageModule = await workflow.fetch("http://127.0.0.1:5173/src/message.js");
  assert.match(await editedMessageModule.text(), /gamma/);
  const update = workflow.hmrUpdates().at(-1);
  assert.equal(update.type, "update");
  assert.equal(update.updates[0].type, "js-update");
  assert.equal(update.updates[0].path, "/src/message.js");
  assert.equal(update.updates[0].acceptedPath, "/src/message.js");
  assert.equal(update.updates[0].label, "gamma");
  const genericEdit = workflow.applySourceEdit("src/message.js", "export const label = \"delta\";\n");
  assert.equal(genericEdit.path, "/src/message.js");
  assert.equal(genericEdit.update.updates[0].path, "/src/message.js");
  assert.equal(genericEdit.update.updates[0].acceptedPath, "/src/message.js");
  assert.equal(genericEdit.update.updates[0].label, "delta");
  assert.equal(genericEdit.statePreserved, true);
  const genericEditedMessageModule = await workflow.fetch("http://127.0.0.1:5173/src/message.js");
  assert.match(await genericEditedMessageModule.text(), /delta/);
  const networkHmrEvents = [];
  const networkHmr = createHmrClient({
    connect() {
      return workflow.network.connectWebSocket("ws://127.0.0.1:5173/", { protocol: "vite-hmr" });
    }
  });
  networkHmr.on("message", (event) => networkHmrEvents.push(event.type));
  networkHmr.start();
  await Promise.resolve();
  workflow.applySourceEdit("src/message.js", "export const label = \"zeta\";\n");
  await Promise.resolve();
  networkHmr.close();
  assert.equal(JSON.stringify(networkHmrEvents), JSON.stringify(["connected", "update"]));
  const styleEdit = workflow.applySourceEdit("/src/style.css", "body { color: red; }\n");
  assert.equal(styleEdit.update.updates[0].type, "css-update");
  assert.equal(styleEdit.update.updates[0].path, "/src/style.css");
  assert.equal(styleEdit.update.updates[0].label, "style.css");
  hmr.close();
  assert.deepEqual(hmrEvents, ["open:1", "message:connected", "message:update", "message:update", "message:update", "message:update"]);
}
}

const artifactWorkflow = new ViteProductWorkflow({
  manager: "npm",
  port: 5299,
  vitePackageArtifact: {
    version: "9.0.0-artifact",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({ name: "vite", version: "9.0.0-artifact", type: "module", bin: { vite: "custom-bin/vite.mjs" } })
      },
      {
        path: "custom-bin/vite.mjs",
        data: "#!/usr/bin/env node\nimport '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import { runBuild } from './build.mjs';\nimport { startDevServer } from './real-server.mjs';\nif (process.argv.includes('build')) {\n  runBuild({ outDir: 'dist' });\n} else {\n  startDevServer({ host: '127.0.0.1', port: Number(process.env.PORT || 5173) });\n}\n"
      },
      {
        path: "dist/node/real-server.mjs",
        data: "import { createHotChannel } from './hmr.mjs';\nimport { registerTransform } from './transform.mjs';\nexport function startDevServer(options) {\n  registerTransform();\n  createHotChannel();\n  global.__viteRegisterDevServer?.({ command: 'dev', host: options.host, port: options.port, source: 'vite-cli' });\n}\n"
      },
      {
        path: "dist/node/build.mjs",
        data: "export function runBuild(options) {\n  global.__viteRegisterBuild?.({ command: 'build', outDir: options.outDir, source: 'vite-cli' });\n}\n"
      },
      {
        path: "dist/node/hmr.mjs",
        data: "export function createHotChannel() {\n  const channel = { send(update) { global.__viteBroadcastHmr?.(update); return update; } };\n  global.__viteRegisterHmrChannel?.({ channel: 'hmr', source: 'vite-cli', transport: 'loopback', sendUpdate: channel.send });\n  return channel;\n}\n"
      },
      {
        path: "dist/node/transform.mjs",
        data: "export function registerTransform() {\n  global.__viteRegisterTransform?.({ mode: 'browser-esm', source: 'vite-cli', transformRequest(request) { return { code: `// artifact transform:${request.path}\\n${request.source}` }; } });\n}\n"
      }
    ]
  }
});
const artifactInstall = artifactWorkflow.install();
assert.equal(artifactInstall.vitePackageSource, "mounted-artifact");
const artifactReadiness = artifactWorkflow.inspectRealCliReadiness();
assert.equal(artifactReadiness.vitePackageSource, "mounted-artifact");
assert.equal(artifactReadiness.capabilityStatus.some((capability) => capability.capability === "mounted-vite-artifact-input" && capability.status === "ready"), true);
assert.equal(artifactReadiness.cliEntrypoint, "/workspace/project/node_modules/vite/custom-bin/vite.mjs");
assert.equal(artifactReadiness.cliEntryReadiness.status, "ready");
assert.deepEqual(
  artifactReadiness.cliModuleGraph.modules.map((mod) => [mod.path, mod.imports]),
  [
    ["/workspace/project/node_modules/vite/custom-bin/vite.mjs", ["../dist/node/cli.mjs"]],
    ["/workspace/project/node_modules/vite/dist/node/cli.mjs", ["./build.mjs", "./real-server.mjs"]],
    ["/workspace/project/node_modules/vite/dist/node/build.mjs", []],
    ["/workspace/project/node_modules/vite/dist/node/real-server.mjs", ["./hmr.mjs", "./transform.mjs"]],
    ["/workspace/project/node_modules/vite/dist/node/hmr.mjs", []],
    ["/workspace/project/node_modules/vite/dist/node/transform.mjs", []]
  ]
);
const artifactCliExecution = await artifactWorkflow.executeRealCli(["--host", "127.0.0.1"], { PORT: "5299" });
assert.deepEqual(artifactCliExecution.serverRegistrations, [
  {
    command: "dev",
    host: "127.0.0.1",
    port: 5299,
    source: "vite-cli"
  }
]);
assert.deepEqual(artifactCliExecution.hmrRegistrations.map(({ channel, source, transport }) => ({ channel, source, transport })), [
  {
    channel: "hmr",
    source: "vite-cli",
    transport: "loopback"
  }
]);
assert.equal(typeof artifactCliExecution.hmrRegistrations[0].sendUpdate, "function");
assert.deepEqual(artifactCliExecution.transformRegistrations.map(({ mode, source }) => ({ mode, source })), [
  {
    mode: "browser-esm",
    source: "vite-cli"
  }
]);
assert.equal(typeof artifactCliExecution.transformRegistrations[0].transformRequest, "function");
await assert.rejects(
  () => artifactWorkflow.executeRealCli(["build"], {}, { isolation: "worker" }),
  /ERR_VITE_CLI_WORKER_FACTORY_REQUIRED/
);
const artifactWorkerExecution = await artifactWorkflow.executeRealCli(
  ["--host", "127.0.0.1"],
  { PORT: "5299" },
  { isolation: "worker", workerFactory: () => new FakeCliEvaluationWorker() }
);
assert.equal(artifactWorkerExecution.mode, "worker-backed-cli-module-evaluation");
assert.deepEqual(artifactWorkerExecution.serverRegistrations, [
  {
    command: "dev",
    host: "127.0.0.1",
    port: 5299,
    source: "vite-cli"
  }
]);
assert.deepEqual(artifactWorkerExecution.hmrRegistrations.map(({ channel, source, transport }) => ({ channel, source, transport })), [
  {
    channel: "hmr",
    source: "vite-cli",
    transport: "loopback"
  }
]);
assert.equal(typeof artifactWorkerExecution.hmrRegistrations[0].sendUpdate, "function");
assert.deepEqual(artifactWorkerExecution.transformRegistrations.map(({ mode, source }) => ({ mode, source })), [
  {
    mode: "browser-esm",
    source: "vite-cli"
  }
]);
assert.equal(typeof artifactWorkerExecution.transformRegistrations[0].transformRequest, "function");
const artifactWorkerTransform = await artifactWorkerExecution.transformRegistrations[0].transformRequest({
  path: "/src/main.jsx",
  source: "console.log('worker')\n"
});
assert.match(artifactWorkerTransform.code, /worker proxy transform:\/src\/main\.jsx/);
const readyTimeoutWorker = new FakeCliEvaluationWorker();
await artifactWorkflow.executeRealCli(
  ["--host", "127.0.0.1"],
  { PORT: "5300" },
  { isolation: "worker", readyTimeoutMs: 17, workerFactory: () => readyTimeoutWorker }
);
assert.equal(readyTimeoutWorker.messages.find((message) => message.type === "cli:evaluate")?.readyTimeoutMs, 17);
const artifactStarted = await artifactWorkflow.startDevServerFromCliExecution();
assert.equal(artifactStarted.moduleTransform, "vite-cli");
const artifactModule = await artifactWorkflow.fetch("http://127.0.0.1:5299/src/main.jsx");
assert.match(await artifactModule.text(), /artifact transform:\/src\/main\.jsx/);
const artifactBuildExecution = await artifactWorkflow.executeRealCli(["build"]);
assert.deepEqual(artifactBuildExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "dist",
    source: "vite-cli"
  }
]);
const artifactWorkerBuildExecution = await artifactWorkflow.executeRealCli(
  ["build"],
  {},
  { isolation: "worker", workerFactory: () => new FakeCliEvaluationWorker() }
);
assert.deepEqual(artifactWorkerBuildExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "dist",
    source: "vite-cli"
  }
]);

const forcedWasiGuardWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: artifactWorkflow.vitePackageArtifact,
  dependencyArtifacts: [
    {
      name: "@napi-rs/wasm-runtime",
      version: "1.2.4",
      mounts: [
        {
          path: "package.json",
          data: JSON.stringify({ name: "@napi-rs/wasm-runtime", version: "1.2.4" })
        }
      ]
    }
  ]
});
forcedWasiGuardWorkflow.install();
const forcedWasiGuardExecution = await forcedWasiGuardWorkflow.executeRealCli(["build"], { NAPI_RS_FORCE_WASI: "error" });
assert.equal(forcedWasiGuardExecution.exitCode, 1);
assert.match(forcedWasiGuardExecution.stderr, /EVITEWASISYNCINIT/);
assert.deepEqual(forcedWasiGuardExecution.buildRegistrations, []);
const sharedWasiGuardExecution = await forcedWasiGuardWorkflow.executeRealCli(["build"]);
assert.equal(sharedWasiGuardExecution.exitCode, 1);
assert.match(sharedWasiGuardExecution.stderr, /EVITEWASIISOLATIONREQUIRED/);
assert.deepEqual(sharedWasiGuardExecution.buildRegistrations, []);
const forcedWasiIsolatedExecution = await forcedWasiGuardWorkflow.executeRealCli(
  ["build"],
  { NAPI_RS_FORCE_WASI: "error" },
  { isolation: "snapshot" }
);
assert.equal(forcedWasiIsolatedExecution.mode, "isolated-snapshot-cli-module-evaluation");
assert.equal(forcedWasiIsolatedExecution.exitCode, 0);
assert.deepEqual(forcedWasiIsolatedExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "dist",
    source: "vite-cli"
  }
]);

const asyncBindingWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: {
    version: "9.0.0-async-binding",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({ name: "vite", version: "9.0.0-async-binding", type: "module", bin: { vite: "bin/vite.mjs" } })
      },
      {
        path: "bin/vite.mjs",
        data: "import '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nrequire('./async-binding.mjs');\n"
      },
      {
        path: "dist/node/async-binding.mjs",
        data: "const value = await Promise.resolve('binding');\nexport const label = value;\n"
      }
    ]
  }
});
asyncBindingWorkflow.install();
const asyncBindingExecution = await asyncBindingWorkflow.executeRealCli(["build"]);
assert.equal(asyncBindingExecution.exitCode, 0);
assert.equal(asyncBindingExecution.asyncBindingReadinessBlocker, null);
assert.equal(asyncBindingExecution.asyncModuleBlocker, null);

const asyncBindingReadinessWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: {
    version: "9.0.0-async-binding-readiness",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({ name: "vite", version: "9.0.0-async-binding-readiness", type: "module", bin: { vite: "bin/vite.mjs" } })
      },
      {
        path: "bin/vite.mjs",
        data: "import '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst binding = require('./async-binding.mjs');\nclass Derived extends binding.Base {}\nvoid Derived;\nsetTimeout(() => process.stdout.write(binding.label), 0);\n"
      },
      {
        path: "dist/node/async-binding.mjs",
        data: "const Base = await Promise.resolve(class Base {});\nexport { Base };\nexport const label = 'ready';\n"
      }
    ]
  }
});
asyncBindingReadinessWorkflow.install();
const asyncBindingReadinessExecution = await asyncBindingReadinessWorkflow.executeRealCli(["build"]);
assert.equal(asyncBindingReadinessExecution.exitCode, 0);
assert.equal(asyncBindingReadinessExecution.stdout, "ready");
assert.equal(asyncBindingReadinessExecution.asyncBindingReadinessBlocker, null);
assert.equal(asyncBindingReadinessExecution.asyncModuleBlocker, null);

const dependencyArtifactWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: {
    version: "9.2.0-artifact",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({ name: "vite", version: "9.2.0-artifact", type: "module", bin: { vite: "bin/vite.mjs" } })
      },
      {
        path: "bin/vite.mjs",
        data: "import '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import { parseAst } from 'rolldown/parseAst';\nglobal.__viteRegisterBuild?.({ command: 'build', outDir: parseAst('dist'), source: 'vite-cli' });\n"
      }
    ]
  },
  dependencyArtifacts: [
    {
      name: "rolldown",
      version: "1.2.0",
      mounts: [
        {
          path: "package.json",
          data: JSON.stringify({
            name: "rolldown",
            version: "1.2.0",
            type: "module",
            exports: {
              "./parseAst": "./parseAst.mjs"
            }
          })
        },
        {
          path: "parseAst.mjs",
          data: "export function parseAst(value) { return value; }\n"
        }
      ]
    }
  ]
});
const viteWasmPolicy = createWasmAdapterPolicy({
  adapters: [
    {
      name: "rolldown-wasi",
      path: "vendor/rolldown.wasm",
      sha256: "0".repeat(64),
      exports: {
        memory: "memory",
        parseAst: "function"
      }
    }
  ],
  candidateReplacements: [
    {
      package: "rolldown",
      adapterName: "rolldown-wasi",
      wasmPackage: "@rolldown/binding-wasm32-wasi",
      fallbackPolicy: "prefer-wasm",
      status: "candidate-test-policy"
    }
  ]
});
const missingDependencyWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: dependencyArtifactWorkflow.vitePackageArtifact,
  wasmAdapterPolicy: viteWasmPolicy
});
missingDependencyWorkflow.install();
assert.deepEqual(missingDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan, {
  summary: {
    missingByKind: {
      "package-artifact": 0,
      "wasm-adapter-candidate": 1,
      "native-hold": 0
    },
    missingCount: 1,
    optionalCount: 0,
    satisfiedCount: 0
  },
  missing: [
    {
      artifactNames: ["rolldown", "@rolldown/binding-wasm32-wasi"],
      kind: "wasm-adapter-candidate",
      name: "rolldown",
      nextAction: "Materialize the JavaScript package surface and route native binding requests through an integrity-pinned WASM adapter.",
      specifiers: ["rolldown/parseAst"],
      wasm: {
        adapterName: "rolldown-wasi",
        fallbackPolicy: "prefer-wasm",
        status: "candidate-test-policy",
        wasmPackage: "@rolldown/binding-wasm32-wasi"
      }
    }
  ],
  optional: [],
  satisfied: []
});
const dependencyArtifactInstall = dependencyArtifactWorkflow.install();
assert.equal(dependencyArtifactInstall.packages.includes("rolldown"), true);
const dependencyArtifactReadiness = dependencyArtifactWorkflow.inspectRealCliReadiness();
assert.equal(
  dependencyArtifactReadiness.cliModuleGraph.issues.some((issue) => issue.specifier === "rolldown/parseAst"),
  false
);
assert.deepEqual(dependencyArtifactReadiness.dependencyMaterializationPlan, {
  summary: {
    missingByKind: {
      "package-artifact": 0,
      "wasm-adapter-candidate": 0,
      "native-hold": 0
    },
    missingCount: 0,
    optionalCount: 0,
    satisfiedCount: 1
  },
  missing: [],
  optional: [],
  satisfied: ["rolldown"]
});
const dependencyArtifactExecution = await dependencyArtifactWorkflow.executeRealCli(["build"]);
assert.deepEqual(dependencyArtifactExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "dist",
    source: "vite-cli"
  }
]);

const optionalDependencyWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: {
    version: "9.2.1-optional-deps",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({ name: "vite", version: "9.2.1-optional-deps", type: "module", bin: { vite: "bin/vite.mjs" } })
      },
      {
        path: "bin/vite.mjs",
        data: "import '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import 'lightningcss';\nglobal.__viteRegisterBuild?.({ command: 'build', outDir: 'dist', source: 'vite-cli' });\n"
      }
    ]
  }
});
optionalDependencyWorkflow.install();
const optionalDependencyPlan = optionalDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan;
assert.deepEqual(optionalDependencyPlan.summary, {
  missingByKind: {
    "package-artifact": 0,
    "wasm-adapter-candidate": 0,
    "native-hold": 0
  },
  missingCount: 0,
  optionalCount: 1,
  satisfiedCount: 0
});
assert.deepEqual(optionalDependencyPlan.missing, []);
assert.deepEqual(optionalDependencyPlan.optional, [
  {
    kind: "optional-dependency-probe",
    nextAction: "Leave this dependency optional unless a project feature explicitly imports it.",
    specifier: "lightningcss"
  }
]);

const actualLikeViteDependencyWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: {
    version: "8.2.0-actual-like-deps",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({
          name: "vite",
          version: "8.2.0-actual-like-deps",
          type: "module",
          bin: { vite: "bin/vite.mjs" },
          dependencies: {
            esbuild: "^0.27.2",
            lightningcss: "^1.33.0",
            picomatch: "^4.0.5",
            postcss: "^8.5.23",
            rolldown: "~1.2.0",
            tinyglobby: "^0.2.17"
          },
          peerDependenciesMeta: {
            tsx: { optional: true },
            yaml: { optional: true }
          }
        })
      },
      {
        path: "bin/vite.mjs",
        data: "import '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import 'esbuild';\nimport 'lightningcss';\nimport 'picomatch';\nimport 'postcss';\nimport 'rolldown';\nimport 'tinyglobby';\nimport 'tsx/cjs/api';\nimport 'yaml';\n"
      }
    ]
  },
  wasmAdapterPolicy: createWasmAdapterPolicy({
    adapters: [
      {
        name: "rolldown-wasi",
        path: "vendor/rolldown.wasm",
        sha256: "0".repeat(64),
        exports: { memory: "memory" }
      },
      {
        name: "esbuild-wasm",
        path: "vendor/esbuild.wasm",
        sha256: "1".repeat(64),
        exports: { memory: "memory" }
      }
    ],
    candidateReplacements: [
      {
        package: "rolldown",
        adapterName: "rolldown-wasi",
        wasmPackage: "@rolldown/binding-wasm32-wasi",
        fallbackPolicy: "prefer-wasm"
      },
      {
        package: "esbuild",
        adapterName: "esbuild-wasm",
        wasmPackage: "esbuild-wasm",
        fallbackPolicy: "prefer-wasm"
      }
    ]
  })
});
actualLikeViteDependencyWorkflow.install();
const actualLikeDependencyPlan = actualLikeViteDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan;
assert.deepEqual(actualLikeDependencyPlan.summary, {
  missingByKind: {
    "package-artifact": 3,
    "wasm-adapter-candidate": 1,
    "native-hold": 0
  },
  missingCount: 4,
  optionalCount: 3,
  satisfiedCount: 0
});
assert.deepEqual(actualLikeDependencyPlan.missing.map((item) => [item.name, item.kind, item.artifactNames]), [
  ["picomatch", "package-artifact", ["picomatch"]],
  ["postcss", "package-artifact", ["postcss"]],
  ["rolldown", "wasm-adapter-candidate", ["rolldown", "@rolldown/binding-wasm32-wasi"]],
  ["tinyglobby", "package-artifact", ["tinyglobby"]]
]);
assert.deepEqual(actualLikeDependencyPlan.optional.map((item) => [item.specifier, item.kind]), [
  ["lightningcss", "optional-dependency-probe"],
  ["tsx/cjs/api", "optional-dependency-probe"],
  ["yaml", "optional-dependency-probe"]
]);

const installedDependencyWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/vendor/rolldown/package.json",
    data: JSON.stringify({
      name: "rolldown",
      version: "1.2.1-installed",
      type: "module",
      exports: {
        "./parseAst": "./parseAst.mjs"
      }
    })
  },
  {
    path: "/vendor/rolldown/parseAst.mjs",
    data: "export function parseAst(value) { return `installed:${value}`; }\n"
  }
]);
const installedDependencyArtifact = createViteDependencyArtifactFromWorkspace({
  reader: installedDependencyWorkspace,
  packageRoot: "/vendor/rolldown"
});
assert.equal(installedDependencyArtifact.name, "rolldown");
assert.equal(installedDependencyArtifact.version, "1.2.1-installed");
assert.deepEqual(installedDependencyArtifact.mounts.map((mount) => mount.path), [
  "package.json",
  "parseAst.mjs"
]);
const aliasDependencyWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/vendor/string-width-cjs/package.json",
    data: JSON.stringify({ name: "string-width", version: "4.2.3", main: "index.js" })
  },
  {
    path: "/vendor/string-width-cjs/index.js",
    data: "module.exports = () => 1;\n"
  }
]);
const aliasDependencyArtifact = createViteDependencyArtifactFromWorkspace({
  name: "string-width-cjs",
  packageRoot: "/vendor/string-width-cjs",
  reader: aliasDependencyWorkspace
});
assert.equal(aliasDependencyArtifact.name, "string-width-cjs");
assert.equal(aliasDependencyArtifact.version, "4.2.3");
const batchDependencyWorkspace = new MemoryPackageManagerWorkspace([
  ...installedDependencyArtifact.mounts.map((mount) => ({
    path: `/workspace/project/node_modules/rolldown/${mount.path}`,
    data: mount.data
  })),
  {
    path: "/workspace/project/node_modules/@rolldown/binding-wasm32-wasi/package.json",
    data: JSON.stringify({ name: "@rolldown/binding-wasm32-wasi", version: "1.2.1-wasm", type: "module" })
  },
  {
    path: "/workspace/project/node_modules/@rolldown/binding-wasm32-wasi/index.mjs",
    data: "export const binding = 'wasm';\n"
  },
  {
    path: "/workspace/project/node_modules/@scope/pkg/package.json",
    data: JSON.stringify({ name: "@scope/pkg", version: "3.4.5", type: "module" })
  },
  {
    path: "/workspace/project/node_modules/@scope/pkg/index.mjs",
    data: "export const ok = true;\n"
  }
]);
const batchDependencyArtifacts = createViteDependencyArtifactsFromWorkspace({
  reader: batchDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  names: ["rolldown", "rolldown", "@scope/pkg"]
});
assert.deepEqual(batchDependencyArtifacts.map((artifact) => [artifact.name, artifact.version]), [
  ["rolldown", "1.2.1-installed"],
  ["@scope/pkg", "3.4.5"]
]);
const planDependencyArtifacts = createViteDependencyArtifactsFromPlan({
  reader: batchDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  plan: missingDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan
});
assert.deepEqual(planDependencyArtifacts.map((artifact) => [artifact.name, artifact.version]), [
  ["rolldown", "1.2.1-installed"],
  ["@rolldown/binding-wasm32-wasi", "1.2.1-wasm"]
]);
const partialDependencyWorkspace = new MemoryPackageManagerWorkspace([
  ...installedDependencyArtifact.mounts.map((mount) => ({
    path: `/workspace/project/node_modules/rolldown/${mount.path}`,
    data: mount.data
  }))
]);
assert.throws(
  () => createViteDependencyArtifactsFromPlan({
    reader: partialDependencyWorkspace,
    nodeModulesRoot: "/workspace/project/node_modules",
    plan: missingDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan
  }),
  /@rolldown\/binding-wasm32-wasi/
);
const partialPlanDependencyArtifacts = createViteDependencyArtifactsFromPlan({
  reader: partialDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  plan: missingDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan,
  skipMissing: true
});
assert.deepEqual(partialPlanDependencyArtifacts.map((artifact) => [artifact.name, artifact.version]), [
  ["rolldown", "1.2.1-installed"]
]);
const installedDependencyWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: dependencyArtifactWorkflow.vitePackageArtifact,
  dependencyArtifacts: [installedDependencyArtifact]
});
installedDependencyWorkflow.install();
assert.deepEqual(installedDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan, {
  summary: {
    missingByKind: {
      "package-artifact": 0,
      "wasm-adapter-candidate": 0,
      "native-hold": 0
    },
    missingCount: 0,
    optionalCount: 0,
    satisfiedCount: 1
  },
  missing: [],
  optional: [],
  satisfied: ["rolldown"]
});
const installedDependencyExecution = await installedDependencyWorkflow.executeRealCli(["build"]);
assert.deepEqual(installedDependencyExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "installed:dist",
    source: "vite-cli"
  }
]);

const binaryDependencyWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/project/node_modules/binary-probe/package.json",
    data: JSON.stringify({ name: "binary-probe", version: "1.0.0", main: "index.cjs" })
  },
  {
    path: "/workspace/project/node_modules/binary-probe/index.cjs",
    data: "const fs = require('fs');\nmodule.exports = fs.readFileSync(__dirname + '/probe.wasm').toString('hex');\n"
  },
  {
    path: "/workspace/project/node_modules/binary-probe/probe.wasm",
    data: "AAECA/8=",
    encoding: "base64"
  }
]);
const binaryDependencyArtifact = createViteDependencyArtifactFromWorkspace({
  reader: binaryDependencyWorkspace,
  packageRoot: "/workspace/project/node_modules/binary-probe"
});
assert.deepEqual(binaryDependencyArtifact.mounts.find((mount) => mount.path === "probe.wasm"), {
  path: "probe.wasm",
  data: "AAECA/8=",
  encoding: "base64"
});
const binaryDependencyWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: {
    version: "9.2.2-binary-dependency",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({ name: "vite", version: "9.2.2-binary-dependency", type: "module", bin: { vite: "bin/vite.mjs" } })
      },
      {
        path: "bin/vite.mjs",
        data: "import '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import probe from 'binary-probe';\nglobal.__viteRegisterBuild?.({ command: 'build', outDir: probe, source: 'vite-cli' });\n"
      }
    ]
  },
  dependencyArtifacts: [binaryDependencyArtifact]
});
binaryDependencyWorkflow.install();
const binaryDependencyExecution = await binaryDependencyWorkflow.executeRealCli(["build"]);
assert.equal(binaryDependencyExecution.exitCode, 0, binaryDependencyExecution.stderr);
assert.deepEqual(binaryDependencyExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "00010203ff",
    source: "vite-cli"
  }
]);

const pureJsDependencyWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/project/node_modules/postcss/package.json",
    data: JSON.stringify({ name: "postcss", version: "8.5.23", type: "module", exports: { ".": "./lib/postcss.mjs" }, dependencies: { "manifest-only": "^1.0.0" } })
  },
  {
    path: "/workspace/project/node_modules/postcss/lib/postcss.mjs",
    data: "import { nanoid } from 'nanoid';\nimport { green } from 'picocolors';\nimport { SourceMapGenerator } from 'source-map-js';\nexport default function postcss(value) { return { css: `${green(value)}:${nanoid(4)}:${new SourceMapGenerator().kind}` }; }\n"
  },
  {
    path: "/workspace/project/node_modules/tinyglobby/package.json",
    data: JSON.stringify({ name: "tinyglobby", version: "0.2.17", type: "module", exports: { ".": "./dist/index.mjs" } })
  },
  {
    path: "/workspace/project/node_modules/tinyglobby/dist/index.mjs",
    data: "import { fdir } from 'fdir';\nimport picomatch from 'picomatch';\nexport function glob(pattern) { return `${new fdir().crawl(pattern)}:${picomatch(pattern)}`; }\n"
  },
  {
    path: "/workspace/project/node_modules/nanoid/package.json",
    data: JSON.stringify({ name: "nanoid", version: "3.3.16", type: "module", exports: { ".": "./index.js" } })
  },
  {
    path: "/workspace/project/node_modules/nanoid/index.js",
    data: "export function nanoid(size) { return `id-${size}`; }\n"
  },
  {
    path: "/workspace/project/node_modules/picocolors/package.json",
    data: JSON.stringify({ name: "picocolors", version: "1.1.1", type: "module", exports: { ".": "./picocolors.js" } })
  },
  {
    path: "/workspace/project/node_modules/picocolors/picocolors.js",
    data: "export function green(value) { return `green:${value}`; }\n"
  },
  {
    path: "/workspace/project/node_modules/source-map-js/package.json",
    data: JSON.stringify({ name: "source-map-js", version: "1.2.1", type: "module", exports: { ".": "./source-map.js" } })
  },
  {
    path: "/workspace/project/node_modules/source-map-js/source-map.js",
    data: "export class SourceMapGenerator { kind = 'map'; }\n"
  },
  {
    path: "/workspace/project/node_modules/fdir/package.json",
    data: JSON.stringify({ name: "fdir", version: "6.5.0", type: "module", exports: { ".": "./index.mjs" } })
  },
  {
    path: "/workspace/project/node_modules/fdir/index.mjs",
    data: "export class fdir { crawl(pattern) { return `crawl:${pattern}`; } }\n"
  },
  {
    path: "/workspace/project/node_modules/picomatch/package.json",
    data: JSON.stringify({ name: "picomatch", version: "4.0.5", type: "module", exports: { ".": "./index.js" } })
  },
  {
    path: "/workspace/project/node_modules/picomatch/index.js",
    data: "export default function picomatch(pattern) { return `match:${pattern}`; }\n"
  },
  {
    path: "/workspace/project/node_modules/manifest-only/package.json",
    data: JSON.stringify({ name: "manifest-only", version: "1.0.0" })
  },
  {
    path: "/workspace/project/node_modules/manifest-only/index.js",
    data: "module.exports = { ok: true };\n"
  }
]);
const pureJsViteArtifact = {
  version: "9.3.0-pure-js-deps",
  mounts: [
    {
      path: "package.json",
      data: JSON.stringify({ name: "vite", version: "9.3.0-pure-js-deps", type: "module", bin: { vite: "bin/vite.mjs" } })
    },
    {
      path: "bin/vite.mjs",
      data: "import '../dist/node/cli.mjs';\n"
    },
    {
      path: "dist/node/cli.mjs",
      data: "import postcss from 'postcss';\nimport { glob } from 'tinyglobby';\nconst output = postcss(glob('dist')).css;\nglobal.__viteRegisterBuild?.({ command: 'build', outDir: output, source: 'vite-cli' });\n"
    }
  ]
};
const pureJsInitialWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: pureJsViteArtifact
});
pureJsInitialWorkflow.install();
assert.deepEqual(pureJsInitialWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.missing.map((item) => item.name), [
  "postcss",
  "tinyglobby"
]);
assert.deepEqual([...new Set(pureJsInitialWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.missing.map((item) => item.kind))], [
  "package-artifact"
]);
assert.deepEqual(pureJsInitialWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.summary, {
  missingByKind: {
    "package-artifact": 2,
    "wasm-adapter-candidate": 0,
    "native-hold": 0
  },
  missingCount: 2,
  optionalCount: 0,
  satisfiedCount: 0
});
const directPureJsArtifacts = createViteDependencyArtifactsFromPlan({
  reader: pureJsDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  plan: pureJsInitialWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan
});
const pureJsDirectWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: pureJsViteArtifact,
  dependencyArtifacts: directPureJsArtifacts
});
pureJsDirectWorkflow.install();
assert.deepEqual(pureJsDirectWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.missing.map((item) => item.name), [
  "fdir",
  "nanoid",
  "picocolors",
  "picomatch",
  "source-map-js"
]);
assert.deepEqual([...new Set(pureJsDirectWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.missing.map((item) => item.kind))], [
  "package-artifact"
]);
assert.deepEqual(pureJsDirectWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.summary, {
  missingByKind: {
    "package-artifact": 5,
    "wasm-adapter-candidate": 0,
    "native-hold": 0
  },
  missingCount: 5,
  optionalCount: 0,
  satisfiedCount: 2
});
const transitivePureJsArtifacts = createViteDependencyArtifactsFromPlan({
  reader: pureJsDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  plan: pureJsDirectWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan
});
const mergedPureJsArtifacts = mergeViteDependencyArtifacts(directPureJsArtifacts, transitivePureJsArtifacts);
assert.deepEqual(mergedPureJsArtifacts.replaced, []);
const pureJsClosure = createViteDependencyArtifactClosureFromWorkspace({
  manager: "pnpm",
  reader: pureJsDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  vitePackageArtifact: pureJsViteArtifact
});
assert.deepEqual(pureJsClosure.iterations.map((iteration) => iteration.extracted), [
  ["postcss", "tinyglobby"],
  ["fdir", "manifest-only", "nanoid", "picocolors", "picomatch", "source-map-js"]
]);
assert.deepEqual(pureJsClosure.remainingPlan.missing, []);
assert.deepEqual(pureJsClosure.artifacts.map((artifact) => artifact.name), [
  "postcss",
  "tinyglobby",
  "fdir",
  "manifest-only",
  "nanoid",
  "picocolors",
  "picomatch",
  "source-map-js"
]);
const pureJsCompleteWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: pureJsViteArtifact,
  dependencyArtifacts: pureJsClosure.artifacts
});
pureJsCompleteWorkflow.install();
assert.deepEqual(pureJsCompleteWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.missing, []);
assert.deepEqual(pureJsCompleteWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.summary, {
  missingByKind: {
    "package-artifact": 0,
    "wasm-adapter-candidate": 0,
    "native-hold": 0
  },
  missingCount: 0,
  optionalCount: 0,
  satisfiedCount: 8
});
const pureJsExecution = await pureJsCompleteWorkflow.executeRealCli(["build"]);
assert.equal(pureJsExecution.exitCode, 0, pureJsExecution.stderr);
assert.deepEqual(pureJsExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "green:crawl:dist:match:dist:id-4:map",
    source: "vite-cli"
  }
]);

const installedViteWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/vendor/vite/package.json",
    data: JSON.stringify({ name: "vite", version: "9.1.0-installed", type: "module", bin: { vite: "bin/vite.mjs" } })
  },
  {
    path: "/vendor/vite/bin/vite.mjs",
    data: "#!/usr/bin/env node\nimport '../dist/node/cli.mjs';\n"
  },
  {
    path: "/vendor/vite/dist/node/cli.mjs",
    data: "import { startDevServer } from './server.mjs';\nstartDevServer({ host: '127.0.0.1', port: Number(process.env.PORT || 5173) });\n"
  },
  {
    path: "/vendor/vite/dist/node/server.mjs",
    data: "export function startDevServer(options) {\n  global.__viteRegisterTransform?.({ mode: 'browser-esm', source: 'vite-cli', transformRequest(request) { return `// installed package transform:${request.path}\\n${request.source}`; } });\n  global.__viteRegisterHmrChannel?.({ channel: 'hmr', source: 'vite-cli', transport: 'loopback', sendUpdate(update) { global.__viteBroadcastHmr?.(update); return update; } });\n  global.__viteRegisterDevServer?.({ command: 'dev', host: options.host, port: options.port, source: 'vite-cli' });\n}\n"
  }
]);
const installedArtifact = createVitePackageArtifactFromWorkspace({
  reader: installedViteWorkspace,
  packageRoot: "/vendor/vite"
});
assert.equal(installedArtifact.version, "9.1.0-installed");
assert.deepEqual(installedArtifact.mounts.map((mount) => mount.path), [
  "bin/vite.mjs",
  "dist/node/cli.mjs",
  "dist/node/server.mjs",
  "package.json"
]);
const installedArtifactWorkflow = new ViteProductWorkflow({
  manager: "npm",
  port: 5301,
  vitePackageArtifact: installedArtifact
});
installedArtifactWorkflow.install();
const installedArtifactServer = await installedArtifactWorkflow.startDevServerFromCliExecution();
assert.equal(installedArtifactServer.source, "cli-execution");
const installedArtifactModule = await installedArtifactWorkflow.fetch("http://127.0.0.1:5301/src/main.jsx");
assert.match(await installedArtifactModule.text(), /installed package transform:\/src\/main\.jsx/);

const npmInstalledWorkspace = new MemoryPackageManagerWorkspace([
  ...installedArtifact.mounts.map((mount) => ({
    path: `/workspace/vite-package/${mount.path}`,
    data: mount.data
  })),
  {
    path: "/workspace/project/package.json",
    data: JSON.stringify({
      name: "vite-package-manager-artifact-fixture",
      version: "1.0.0",
      private: true,
      dependencies: {
        vite: "file:../vite-package"
      }
    })
  },
  {
    path: "/workspace/project/package-lock.json",
    data: JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            vite: "file:../vite-package"
          }
        },
        "../vite-package": {
          version: "9.1.0-installed"
        },
        "node_modules/vite": {
          resolved: "../vite-package",
          link: true
        }
      }
    })
  }
]);
const installPlan = createNpmInstallPlan({
  cwd: "/workspace/project",
  reader: npmInstalledWorkspace
});
applyNpmInstallPlan(installPlan, npmInstalledWorkspace);
const npmInstalledArtifact = createVitePackageArtifactFromWorkspace({
  reader: npmInstalledWorkspace,
  packageRoot: "/workspace/project/node_modules/vite"
});
assert.equal(npmInstalledArtifact.version, "9.1.0-installed");
const npmInstalledArtifactWorkflow = new ViteProductWorkflow({
  manager: "npm",
  port: 5302,
  vitePackageArtifact: npmInstalledArtifact
});
npmInstalledArtifactWorkflow.install();
const npmInstalledServer = await npmInstalledArtifactWorkflow.startDevServerFromCliExecution();
assert.equal(npmInstalledServer.source, "cli-execution");
const npmInstalledModule = await npmInstalledArtifactWorkflow.fetch("http://127.0.0.1:5302/src/main.jsx");
assert.match(await npmInstalledModule.text(), /installed package transform:\/src\/main\.jsx/);

const pnpmInstalledWorkspace = new MemoryPackageManagerWorkspace([
  ...installedArtifact.mounts.map((mount) => ({
    path: `/workspace/packages/vite/${mount.path}`,
    data: mount.data
  })),
  {
    path: "/workspace/project/package.json",
    data: JSON.stringify({
      name: "vite-pnpm-artifact-fixture",
      version: "1.0.0",
      private: true,
      packageManager: "pnpm@9.15.9",
      dependencies: {
        vite: "workspace:*"
      }
    })
  },
  {
    path: "/workspace/project/pnpm-workspace.yaml",
    data: "packages:\n  - \"../packages/*\"\n"
  },
  {
    path: "/workspace/project/pnpm-lock.yaml",
    data: "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      vite:\n        specifier: workspace:*\n        version: link:../packages/vite\n"
  }
]);
const pnpmPlan = createPnpmStorePlan({
  cwd: "/workspace/project",
  reader: pnpmInstalledWorkspace
});
applyPnpmStorePlan(pnpmPlan, pnpmInstalledWorkspace);
const pnpmInstalledArtifact = createVitePackageArtifactFromWorkspace({
  reader: pnpmInstalledWorkspace,
  packageRoot: "/workspace/project/node_modules/vite"
});
assert.equal(pnpmInstalledArtifact.version, "9.1.0-installed");
const pnpmInstalledArtifactWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  port: 5303,
  vitePackageArtifact: pnpmInstalledArtifact
});
pnpmInstalledArtifactWorkflow.install();
const pnpmInstalledServer = await pnpmInstalledArtifactWorkflow.startDevServerFromCliExecution();
assert.equal(pnpmInstalledServer.source, "cli-execution");
const pnpmInstalledModule = await pnpmInstalledArtifactWorkflow.fetch("http://127.0.0.1:5303/src/main.jsx");
assert.match(await pnpmInstalledModule.text(), /installed package transform:\/src\/main\.jsx/);

assert.throws(
  () => new ViteProductWorkflow({
    manager: "npm",
    vitePackageArtifact: {
      version: "bad",
      mounts: []
    }
  }).install(),
  (error) => error.code === "EVITEARTIFACTMANIFEST" && error.path === "/workspace/project/node_modules/vite/package.json"
);
assert.throws(
  () => new ViteProductWorkflow({
    manager: "npm",
    vitePackageArtifact: {
      version: "bad",
      mounts: [
        {
          path: "package.json",
          data: JSON.stringify({ name: "not-vite", version: "bad", type: "module", bin: { vite: "bin/vite.js" } })
        }
      ]
    }
  }).install(),
  (error) => error.code === "EVITEARTIFACTNAME" && error.path === "/workspace/project/node_modules/vite/package.json"
);
assert.throws(
  () => new ViteProductWorkflow({
    manager: "npm",
    vitePackageArtifact: {
      version: "bad",
      mounts: [
        {
          path: "package.json",
          data: JSON.stringify({ name: "vite", version: "bad", type: "module", bin: { vite: "missing/vite.js" } })
        }
      ]
    }
  }).install(),
  (error) => error.code === "EVITEARTIFACTBIN" && error.path === "/workspace/project/node_modules/vite/missing/vite.js"
);

console.log("vite product workflow test ok");

function expectedFrameworkPackage(template) {
  if (template === "react") return "react";
  if (template === "vue-runtime") return "vue";
  return "svelte";
}

function entryPathForTemplate(template) {
  if (template === "react") return "src/main.jsx";
  return "src/main.js";
}
