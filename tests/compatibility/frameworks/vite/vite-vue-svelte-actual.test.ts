import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import {
  runViteProductCliBackedWorkflow,
  runViteProductWorkflow
} from "../../../../packages/node-runtime/src/frameworks/vite-workflow.ts";

const support = JSON.parse(fs.readFileSync(new URL("../../../../compat/framework-product-support.json", import.meta.url), "utf8"));

const cases = [
  { framework: "vite-vue", template: "vue-runtime", packageName: "vue" },
  { framework: "vite-svelte", template: "svelte", packageName: "svelte" }
];

for (const { framework, template, packageName } of cases) {
  const contract = support.frameworks.find((entry) => entry.id === framework);
  assert.equal(contract?.grade, "supported");
  assert.deepEqual(contract.packageManagers, ["npm", "pnpm"]);

  for (const manager of ["npm", "pnpm"]) {
    const adapterStartedAt = performance.now();
    const adapter = runViteProductWorkflow({ manager, template, projectRoot: `/workspace/${template}-${manager}` });
    const adapterElapsedMs = performance.now() - adapterStartedAt;
    assert.ok(
      adapterElapsedMs <= support.performanceBudgets.adapterWorkflowMs,
      `${framework}/${manager} adapter exceeded ${support.performanceBudgets.adapterWorkflowMs}ms: ${adapterElapsedMs}`
    );
    assert.equal(adapter.runtime, "browser-guest-node-runtime");
    assert.equal(adapter.template, template);
    assert.equal(adapter.install.installed, true);
    assert.equal(adapter.install.packages.includes(packageName), true);
    assert.equal(adapter.devServer.running, true);
    assert.equal(adapter.preview.statusCode, 200);
    assert.match(adapter.preview.body, /alpha:1/);
    assert.equal(adapter.hmr.statePreserved, true);
    assert.match(adapter.hmr.after, /beta:1/);
    assert.equal(adapter.build.files.includes("dist/index.html"), true);
    assert.equal(adapter.reloadRecovery.restarted, true);
    assert.match(adapter.reloadRecovery.previewAfterRestart, /beta:1/);

    const cliStartedAt = performance.now();
    const cli = await runViteProductCliBackedWorkflow({
      manager,
      template,
      projectRoot: `/workspace/${template}-${manager}-cli`,
      port: template === "vue-runtime" ? 5291 : 5292
    });
    const cliElapsedMs = performance.now() - cliStartedAt;
    assert.ok(
      cliElapsedMs <= support.performanceBudgets.cliBackedWorkflowMs,
      `${framework}/${manager} CLI workflow exceeded ${support.performanceBudgets.cliBackedWorkflowMs}ms: ${cliElapsedMs}`
    );
    assert.equal(cli.devServer.source, "cli-execution");
    assert.equal(cli.devServer.moduleTransform, "vite-cli");
    assert.match(cli.preview.body, /alpha:1/);
    assert.equal(cli.hmr.statePreserved, true);
    assert.equal(cli.build.files.includes("dist/index.html"), true);
    assert.equal(cli.reloadRecovery.restarted, true);
    assert.match(cli.reloadRecovery.previewAfterRestart, /beta:1/);
  }
}

console.log("vite vue/svelte actual worker-backed validation ok");
