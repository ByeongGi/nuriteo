import assert from "node:assert/strict";
import {
  runViteProductCliBackedWorkflow,
  runViteProductWorkflow
} from "../../packages/node-runtime/src/frameworks/vite-workflow.ts";

const cases = [
  { template: "vue-runtime", packageName: "vue" },
  { template: "svelte", packageName: "svelte" }
];

for (const { template, packageName } of cases) {
  for (const manager of ["npm", "pnpm"]) {
    const adapter = runViteProductWorkflow({ manager, template, projectRoot: `/workspace/${template}-${manager}` });
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

    const cli = await runViteProductCliBackedWorkflow({
      manager,
      template,
      projectRoot: `/workspace/${template}-${manager}-cli`,
      port: template === "vue-runtime" ? 5291 : 5292
    });
    assert.equal(cli.devServer.source, "cli-execution");
    assert.equal(cli.devServer.moduleTransform, "vite-cli");
    assert.match(cli.preview.body, /alpha:1/);
    assert.equal(cli.hmr.statePreserved, true);
    assert.equal(cli.build.files.includes("dist/index.html"), true);
  }
}

console.log("vite vue/svelte actual worker-backed validation ok");
