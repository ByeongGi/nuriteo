import assert from "node:assert/strict";

import {
  createProjectWorkspaceEditorBridge,
  createProjectWorkspaceSourceEditBridge,
  createProjectWorkspaceStore
} from "../../packages/browser-host/src/index.ts";

const project = createProjectWorkspaceStore({
  projectId: "project-editor",
  root: "/workspace/app"
});
project.writeText("package.json", "{\"scripts\":{\"dev\":\"vite\"}}\n");
project.writeText("src/main.js", "console.log(\"hello\")\n");

const savedEvents = [];
const sourceEdits = [];
const editor = createProjectWorkspaceEditorBridge(project, {
  onSave: createProjectWorkspaceSourceEditBridge({
    applySourceEdit(path, data) {
      sourceEdits.push({ path, data });
      return { path, data };
    }
  })
});

assert.deepEqual(editor.tree(), [
  {
    children: [
      {
        dirty: false,
        name: "main.js",
        path: "/workspace/app/src/main.js",
        type: "file"
      }
    ],
    name: "src",
    path: "/workspace/app/src",
    type: "directory"
  },
  {
    dirty: false,
    name: "package.json",
    path: "/workspace/app/package.json",
    type: "file"
  }
]);

const opened = editor.openFile("src/main.js");
assert.equal(opened.path, "/workspace/app/src/main.js");
assert.equal(opened.data, "console.log(\"hello\")\n");
assert.equal(opened.dirty, false);

const edited = editor.editText("src/main.js", "console.log(\"edited\")\n");
assert.equal(edited.dirty, true);
assert.equal(project.readText("src/main.js"), "console.log(\"hello\")\n");
assert.deepEqual(editor.dirtyFiles().map((file) => file.path), ["/workspace/app/src/main.js"]);
assert.equal(editor.tree()[0].children[0].dirty, true);
assert.deepEqual(editor.search("edited"), [
  {
    path: "/workspace/app/src/main.js",
    line: 1,
    column: 14,
    snippet: "console.log(\"edited\")"
  }
]);

const saved = editor.saveFile("src/main.js");
assert.equal(saved.dirty, false);
assert.equal(project.readText("src/main.js"), "console.log(\"edited\")\n");
assert.deepEqual(editor.dirtyFiles(), []);
savedEvents.push(...sourceEdits);
assert.deepEqual(savedEvents, [{ path: "src/main.js", data: "console.log(\"edited\")\n" }]);

const created = editor.createFile("src/App.jsx", "export function App() {}\n");
assert.equal(created.path, "/workspace/app/src/App.jsx");
assert.equal(editor.search("App")[0].path, "/workspace/app/src/App.jsx");

const renamed = editor.renameFile("src/App.jsx", "src/App.tsx");
assert.equal(renamed.path, "/workspace/app/src/App.tsx");
assert.throws(
  () => project.readText("src/App.jsx"),
  (error) => error.code === "ENOENT"
);
assert.equal(project.readText("src/App.tsx"), "export function App() {}\n");

editor.editText("src/App.tsx", "export const App = 1;\n");
assert.equal(editor.discard("src/App.tsx").data, "export function App() {}\n");

editor.deleteFile("src/App.tsx");
assert.throws(
  () => editor.openFile("src/App.tsx"),
  (error) => error.code === "ENOENT"
);
assert.deepEqual(editor.search("App"), []);

console.log("browser host project editor bridge test ok");
