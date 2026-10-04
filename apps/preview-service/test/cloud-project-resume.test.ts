import assert from "node:assert/strict";

import { createPreviewWorkflowController } from "../../../packages/preview-service/src/controller.ts";

const controller = createPreviewWorkflowController();
const snapshot = controller.importProjectFiles([
  { path: "LICENSE", content: "Apache-2.0\n" },
  { path: "notes/🚀", content: "valid astral path\n" },
  { path: "package.json", kind: "text", bytes: new TextEncoder().encode('{"scripts":{"dev":"vite"},"dependencies":{"vite":"latest"}}\n') },
  { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'\n" },
  { path: "public/logo.bin", kind: "binary", bytes: Uint8Array.of(0, 255, 1, 128) },
  { path: "src/main.ts", kind: "text", bytes: new TextEncoder().encode("export const resumed = true\n") }
], "Remote project");

assert.equal(snapshot.source, "snapshot");
assert.equal(snapshot.project?.readText("/workspace/app/src/main.ts"), "export const resumed = true\n");
assert.equal(snapshot.project?.metadata.name, "Remote project");
assert.equal(snapshot.workflow?.workspace.readText("/workspace/app/LICENSE"), "Apache-2.0\n");
assert.equal(snapshot.workflow?.workspace.readText("/workspace/app/notes/🚀"), "valid astral path\n");
assert.equal(snapshot.workflow?.workspace.readText("/workspace/app/pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
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
assert.equal(controller.exportProjectFiles().find((file) => file.path === "notes/🚀")?.path, "notes/🚀");

const unpairedHighPath = `high-${String.fromCharCode(0xd800)}`;
const unpairedLowPath = `low-${String.fromCharCode(0xdc00)}`;

for (const path of [
  "../escape",
  "/absolute",
  "C:/absolute",
  "nested\\escape",
  "./dot",
  "nested//empty",
  "control\u0000byte",
  "e\u0301.txt",
  unpairedHighPath,
  unpairedLowPath,
  `${Array.from({ length: 33 }, () => "segment").join("/")}/file.txt`
]) {
  assert.throws(
    () => controller.importProjectFiles([{ path, content: "unsafe\n" }]),
    /unsafe or duplicate path/u,
    `unsafe imported path must be rejected: ${JSON.stringify(path)}`
  );
}
assert.throws(
  () => controller.importProjectFiles([{ path: "large.txt", content: "x".repeat(1024 * 1024 + 1) }]),
  /per-file limit/u
);
assert.throws(
  () => controller.importProjectFiles(Array.from({ length: 257 }, (_, index) => ({ path: `file-${index}`, content: "" }))),
  /file limit/u
);
assert.throws(
  () => controller.importProjectFiles(Array.from({ length: 9 }, (_, index) => ({ path: `large-${index}`, content: "x".repeat(1024 * 1024) }))),
  /byte limit/u
);
assert.throws(
  () => controller.importProjectFiles([{ path: "duplicate", content: "a" }, { path: "duplicate", content: "b" }]),
  /unsafe or duplicate path/u
);
console.log("preview-service cloud project resume test ok");
