import assert from "node:assert/strict";

import {
  createProjectWorkspaceDevServerChangeBridge,
  createProjectWorkspaceEditorBridge,
  createProjectWorkspaceSourceEditBridge,
  createProjectWorkspaceStore
} from "../../../../packages/browser-host/src/index.ts";
import { ViteProductWorkflow } from "../../../../packages/node-runtime/src/index.ts";

const workflow = new ViteProductWorkflow({ manager: "npm" });
workflow.install();
workflow.startDevServerFromPackageScript();

const project = createProjectWorkspaceStore({
  projectId: "vite-editor-source-edit",
  root: workflow.projectRoot
});
project.writeText("src/message.js", "export const label = \"alpha\";\n");

let lastEdit = null;
let lastChange = null;
let lastDiagnostic = null;
const changeBridge = createProjectWorkspaceDevServerChangeBridge(workflow, {
  onDiagnostic(diagnostic) {
    lastDiagnostic = diagnostic;
  }
});
const editor = createProjectWorkspaceEditorBridge(project, {
  onChange: (event) => {
    lastChange = changeBridge(event);
  },
  onSave: (event) => {
    lastEdit = createProjectWorkspaceSourceEditBridge(workflow)(event);
  }
});

editor.editText("src/message.js", "export const label = \"from-editor\";\n");
const saved = editor.saveFile("src/message.js");
assert.equal(saved.dirty, false);
assert.equal(lastEdit.path, "/src/message.js");
assert.equal(lastEdit.update.updates[0].label, "from-editor");
assert.equal(lastChange.kind, "source-save");
assert.equal(lastChange.hmrResult.update.updates[0].label, "from-editor");
assert.equal(workflow.hmrUpdates().at(-1).updates[0].path, "/src/message.js");

const preview = await workflow.fetch("http://127.0.0.1:5173/src/message.js");
assert.match(await preview.text(), /from-editor/);

editor.createFile("src/created.js", "export const label = \"created\";\n");
assert.equal(lastChange.kind, "source-create");
assert.equal(lastChange.hmrResult.update.updates[0].path, "/src/created.js");

editor.renameFile("src/created.js", "src/renamed.js");
assert.equal(lastChange.kind, "source-rename");
assert.equal(lastDiagnostic.code, "EDEVSERVER_SOURCE_RENAMED");
assert.equal(lastDiagnostic.previousPath, "/workspace/project/src/created.js");

editor.deleteFile("src/renamed.js");
assert.equal(lastChange.kind, "source-delete");
assert.equal(lastDiagnostic.code, "EDEVSERVER_SOURCE_DELETED");

console.log("vite editor source edit bridge test ok");
