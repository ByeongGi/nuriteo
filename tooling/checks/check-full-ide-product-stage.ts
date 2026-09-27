import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const contract = JSON.parse(fs.readFileSync("compat/full-ide-product-stage.json", "utf8"));
const document = fs.readFileSync("docs/productization/full-ide-product-stage.md", "utf8");
const editor = fs.readFileSync("apps/preview-service/src/components/CodeEditor.tsx", "utf8");

assert(contract.schemaVersion === 1, "unexpected full IDE product-stage schema");
assert(contract.status === "project-complete", "full IDE product stage is not project-complete");
assert(contract.milestones.lspTransport.status === "project-complete", "LSP product status changed");
assert(contract.milestones.extensionHost.status === "project-complete", "extension host product status changed");
assert(contract.milestones.debugAdapter.status === "project-complete", "debug adapter product status changed");
assert(document.includes("not VS Code compatible"), "document must preserve the compatibility non-claim");
assert(document.includes("Content-Security-Policy"), "document must describe the CSP boundary");
assert(editor.includes("LSP {lspState}"), "editor status does not expose LSP lifecycle");
assert(fs.existsSync("apps/preview-service/src/workers/extensionHost.worker.ts"), "extension host worker missing");
assert(fs.existsSync("apps/preview-service/src/workers/languageServerProcess.worker.ts"), "language server process worker missing");
assert(fs.existsSync("apps/preview-service/src/workers/debugRuntimeProcess.worker.ts"), "debug runtime process worker missing");
assert(fs.existsSync("apps/preview-service/src/lib/sourceMap.ts"), "source-map bridge missing");
assert(fs.existsSync("apps/preview-service/src/lib/extensionPermissions.ts"), "persistent extension permission store missing");
assert(fs.existsSync("apps/preview-service/src/lib/typescriptProject.ts"), "compiler-backed TypeScript project missing");
assert(fs.existsSync("apps/preview-service/src/lib/browserExtensionManager.ts"), "multi-extension manager missing");
assert(fs.existsSync("apps/preview-service/src/lib/safeJavaScriptRuntime.ts"), "safe workspace debugger runtime missing");
assert(fs.existsSync("apps/preview-service/src/lib/debugConfiguration.ts"), "persisted debugger configuration missing");
assert(fs.existsSync("apps/preview-service/src/lib/workspaceEdit.ts"), "validated workspace edit bridge missing");
for (const test of contract.tests) assert(fs.existsSync(test), `full IDE product-stage test missing: ${test}`);

console.log("full IDE product-stage contract ok");
