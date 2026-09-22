import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const {
  createPreviewWorkflowController,
  injectPreviewErrorBridge,
  PREVIEW_ERROR_BRIDGE_MESSAGE_TYPE
} = await import(pathToFileURL(path.join(root, "packages/preview-service/src/index.ts")).href);

const controller = createPreviewWorkflowController();
const loaded = controller.loadTemplate("vite-react");
assert.equal(loaded.phase, "template_loaded");
assert.ok(loaded.project);

const tree = controller.exportTreeJson();
assert.ok(tree["package.json"], "exportTreeJson should include package.json");
assert.ok(tree["package.json"].file?.contents.includes("\""), "package.json should be a file node");

const yarn = await controller.runShellCommand("yarn install");
assert.notEqual(yarn.exitCode, 0);
assert.match(yarn.stderr, /yarn/i);
assert.match(yarn.stderr, /npm|pnpm/i);
assert.match(yarn.stderr, /evaluation-only|unsupported/i);

const before = controller.getChangeStatus();
assert.deepEqual(before.dirty, []);
assert.equal(typeof before.untrackedHint, "string");
assert.equal(before.hasGitMarker, false);

const sourceFiles = loaded.project.listFiles();
const messagePath = sourceFiles.find((file) => /\/message\.(?:js|jsx|ts|tsx)$/.test(file.path))?.path
  || sourceFiles.find((file) => /\/src\/.*\.(?:js|jsx|ts|tsx)$/.test(file.path))?.path;
assert.ok(messagePath, "expected a JavaScript or TypeScript source module");

const editor = controller.getSnapshot().editor;
assert.ok(editor);
editor.editText(messagePath, 'export const label = "ide4-dirty";\n');

const after = controller.getChangeStatus();
assert.ok(after.dirty.length >= 1);
assert.ok(
  after.dirty.some((entry) => /message\.(?:js|jsx|ts|tsx)$/.test(entry) || entry.includes("/src/")),
  `dirty should include edited file, got ${JSON.stringify(after.dirty)}`
);

const html = "<html><body><h1>preview</h1></body></html>";
const injected = injectPreviewErrorBridge(html);
assert.match(injected, /cargo-preview-error/);
assert.match(injected, new RegExp(PREVIEW_ERROR_BRIDGE_MESSAGE_TYPE));
assert.ok(injected.indexOf("data-cargo-preview-error-bridge") < injected.toLowerCase().indexOf("</body>"));

controller.setPreviewErrorBridge(true);
const pathZip = controller.exportPathZip("src");
assert.ok(pathZip instanceof Uint8Array);
assert.ok(pathZip.byteLength > 0);

console.log("preview-service ide4-runtime ok");
