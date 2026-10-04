import assert from "node:assert/strict";

import { createPreviewWorkflowController } from "../../../packages/preview-service/src/controller.ts";

const controller = createPreviewWorkflowController();
const snapshot = controller.importProjectFiles([
  { path: "package.json", kind: "text", bytes: new TextEncoder().encode('{"scripts":{"dev":"vite"},"dependencies":{"vite":"latest"}}\n') },
  { path: "public/logo.bin", kind: "binary", bytes: Uint8Array.of(0, 255, 1, 128) },
  { path: "src/main.ts", kind: "text", bytes: new TextEncoder().encode("export const resumed = true\n") }
], "Remote project");

assert.equal(snapshot.source, "snapshot");
assert.equal(snapshot.project?.readText("/workspace/app/src/main.ts"), "export const resumed = true\n");
assert.equal(snapshot.project?.metadata.name, "Remote project");
assert.deepEqual(
  snapshot.workflow?.workspace.readBytes("/workspace/app/public/logo.bin"),
  Uint8Array.of(0, 255, 1, 128),
  "binary Project files must be mounted into the executable Runtime workspace"
);
snapshot.workflow?.install();
snapshot.workflow?.startDevServer();
const binaryPreview = snapshot.workflow?.preview("/public/logo.bin");
assert.equal(binaryPreview?.headers?.["content-type"], "application/octet-stream");
assert.deepEqual(binaryPreview?.body, Uint8Array.of(0, 255, 1, 128));
snapshot.workflow?.workspace.rename("/workspace/app/public/logo.bin", "/workspace/app/public/renamed.bin");
snapshot.workflow?.workspace.remove("/workspace/app/src/main.ts");
snapshot.workflow?.workspace.writeBytes("/workspace/app/generated.dat", Uint8Array.of(254, 253));
const roundTrip = controller.exportProjectFiles();
assert.deepEqual(roundTrip.find((file) => file.path === "generated.dat")?.bytes, Uint8Array.of(254, 253));
assert.equal(roundTrip.find((file) => file.path === "generated.dat")?.kind, "binary");
assert.equal(roundTrip.some((file) => file.path.startsWith("node_modules/")), true, "export must not pre-filter Runtime files before BND admission");
assert.equal(roundTrip.some((file) => file.path === "src/main.ts"), false, "deleted Runtime files must not survive export");
const renamed = roundTrip.find((file) => file.path === "public/renamed.bin");
assert.deepEqual(renamed?.bytes, Uint8Array.of(0, 255, 1, 128));
renamed?.bytes.fill(7);
assert.deepEqual(controller.exportProjectFiles().find((file) => file.path === "public/renamed.bin")?.bytes, Uint8Array.of(0, 255, 1, 128));
console.log("preview-service cloud project resume test ok");
