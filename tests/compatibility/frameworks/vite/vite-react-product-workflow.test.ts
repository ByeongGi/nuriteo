import assert from "node:assert/strict";
import { createLoopbackNetwork, createCliEvaluationHttpBridge, evaluateCliModuleWorkerMessage, runViteProductCliBackedWorkflow, runViteProductWorkflow, ViteProductWorkflow } from "../../../../packages/node-runtime/src/index.ts";
import { createHmrClient, createPreviewRelay, createPreviewSessionRegistry } from "../../../../packages/preview/src/index.ts";

function expectedFrameworkPackage(template) {
  if (template === "react") return "react";
  if (template === "vue-runtime") return "vue";
  return "svelte";
}

function entryPathForTemplate(template) {
  if (template === "react") return "src/main.jsx";
  return "src/main.js";
}

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

await import("./vite-react-product-workflow-deps.ts");
await import("./vite-react-product-workflow-cases.ts");

console.log("vite product workflow test ok");
