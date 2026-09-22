import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const contract = JSON.parse(fs.readFileSync("compat/ide-polish.json", "utf8"));
const document = fs.readFileSync("docs/productization/ide-polish.md", "utf8");
const editor = fs.readFileSync("apps/preview-service/src/components/CodeEditor.tsx", "utf8");
const app = fs.readFileSync("apps/preview-service/src/App.tsx", "utf8");

assert(contract.schemaVersion === 1, "unexpected IDE polish schema");
assert(contract.status === "supported", "IDE polish is not supported");
for (const [feature, status] of Object.entries(contract.features)) {
  assert(Array.isArray(status) || status === "supported" || status === "documented-subset", `invalid IDE feature status: ${feature}`);
  assert(document.includes(feature), `IDE polish document missing feature: ${feature}`);
}
assert(editor.includes("onChange={(value) => editFile(splitPath"), "split editor is not editable");
assert(editor.includes("onClick={() => saveFile(splitPath)}"), "split editor has no explicit save action");
assert(app.includes("<CodeEditor model={model}"), "IDE editor surface missing");
for (const test of contract.tests) assert(fs.existsSync(test), `IDE polish test missing: ${test}`);

console.log("IDE polish contract ok");
