import assert from "node:assert/strict";
import { createPreviewWorkflowController } from "../../../packages/workspace-runtime/src/index.ts";

const controller = createPreviewWorkflowController();
controller.loadTemplate("vite-react");

const snap = controller.getSnapshot();
assert.ok(snap.workflow, "workflow expected");

// Node-side offline soak: guest workflow preview keeps answering without network.
snap.workflow.install();
snap.workflow.startDevServerFromPackageScript("dev");

const first = snap.workflow.preview("/");
assert.equal(first.statusCode, 200);
assert.match(String(first.body || ""), /html|app|root|div/i);

const second = snap.workflow.preview("/");
assert.equal(second.statusCode, 200);

const tree = controller.exportTreeJson();
assert.ok(Object.keys(tree).length > 0, "export tree should include files");

const yarn = await controller.runShellCommand("yarn --version");
assert.equal(yarn.exitCode, 0, yarn.stderr);
assert.match(yarn.stdout, /yarn/i);

console.log("preview-service ide-offline-soak ok");
