import assert from "node:assert/strict";

import { createLoopbackNetwork, runViteProductWorkflow, ViteProductWorkflow } from "../../packages/node-runtime/src/index.ts";
import { createHmrClient, createPreviewRelay, createPreviewSessionRegistry } from "../../packages/preview/src/index.ts";

for (const template of ["react", "vue-runtime", "svelte"]) {
for (const manager of ["npm", "pnpm"]) {
  const result = runViteProductWorkflow({ manager, template });

  assert.equal(result.runtime, "browser-guest-node-runtime");
  assert.equal(result.manager, manager);
  assert.equal(result.template, template);
  assert.equal(result.install.installed, true);
  assert.equal(result.install.packages.includes("vite"), true);
  assert.equal(result.install.packages.includes(expectedFrameworkPackage(template)), true);
  assert.equal(result.realCliReadiness.status, "blocked");
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
  assert.deepEqual(cliExecution.hmrRegistrations, [
    {
      channel: "hmr",
      source: "vite-cli",
      transport: "loopback"
    }
  ]);
  assert.deepEqual(cliExecution.transformRegistrations, [
    {
      mode: "browser-esm",
      source: "vite-cli"
    }
  ]);
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
  assert.match(await cliEntryModule.text(), /transformed by vite-cli/);
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
  hmr.close();
  assert.deepEqual(hmrEvents, ["open:1", "message:connected", "message:update"]);
}
}

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
