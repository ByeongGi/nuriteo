import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const contract = JSON.parse(fs.readFileSync("compat/full-ide-product-stage.json", "utf8"));
const document = fs.readFileSync("docs/productization/full-ide-product-stage.md", "utf8");
const editor = fs.readFileSync("apps/preview-service/src/components/CodeEditor.tsx", "utf8");

assert(contract.schemaVersion === 1, "unexpected full IDE product-stage schema");
assert(contract.status === "active", "full IDE product stage must remain explicitly active");
assert(contract.milestones.lspTransport.status === "vertical-slice", "LSP vertical slice status changed");
assert(contract.milestones.extensionHost.status === "vertical-slice", "extension host vertical slice status changed");
assert(contract.milestones.debugAdapter.status === "vertical-slice", "debug adapter vertical slice status changed");
assert(document.includes("not VS Code compatible"), "document must preserve the compatibility non-claim");
assert(document.includes("Content-Security-Policy"), "document must describe the CSP boundary");
assert(editor.includes("LSP {lspState}"), "editor status does not expose LSP lifecycle");
assert(fs.existsSync("apps/preview-service/src/workers/extensionHost.worker.ts"), "extension host worker missing");
assert(fs.existsSync("apps/preview-service/src/workers/debugAdapter.worker.ts"), "debug adapter worker missing");
for (const test of contract.tests) assert(fs.existsSync(test), `full IDE product-stage test missing: ${test}`);

console.log("full IDE product-stage contract ok");
