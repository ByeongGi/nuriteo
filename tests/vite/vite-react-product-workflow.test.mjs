import assert from "node:assert/strict";

import { runViteReactProductWorkflow } from "../../packages/node-runtime/src/index.ts";

for (const manager of ["npm", "pnpm"]) {
  const result = runViteReactProductWorkflow({ manager });

  assert.equal(result.runtime, "browser-guest-node-runtime");
  assert.equal(result.manager, manager);
  assert.equal(result.install.installed, true);
  assert.equal(result.install.packages.includes("vite"), true);
  assert.equal(result.install.packages.includes("react"), true);
  assert.equal(result.devServer.running, true);
  assert.equal(result.preview.statusCode, 200);
  assert.match(result.preview.body, /alpha:1/);
  assert.match(result.hmr.before, /alpha:1/);
  assert.match(result.hmr.after, /beta:1/);
  assert.equal(result.hmr.statePreserved, true);
  assert.equal(result.build.files.includes("dist/index.html"), true);
  assert.match(result.build.distSmoke, /beta:1/);
  assert.equal(result.reloadRecovery.restarted, true);
  assert.match(result.reloadRecovery.previewAfterRestart, /beta:1/);
}

console.log("vite react product workflow test ok");
