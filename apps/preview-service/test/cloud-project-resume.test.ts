import assert from "node:assert/strict";

import { createPreviewWorkflowController } from "../../../packages/preview-service/src/controller.ts";

const controller = createPreviewWorkflowController();
const snapshot = controller.importProjectFiles([
  { path: "package.json", content: '{"scripts":{"dev":"vite"},"dependencies":{"vite":"latest"}}\n' },
  { path: "src/main.ts", content: "export const resumed = true\n" }
], "Remote project");

assert.equal(snapshot.source, "snapshot");
assert.equal(snapshot.project?.readText("/workspace/app/src/main.ts"), "export const resumed = true\n");
assert.equal(snapshot.project?.metadata.name, "Remote project");
console.log("preview-service cloud project resume test ok");
