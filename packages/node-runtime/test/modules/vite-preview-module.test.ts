import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { browserPreviewModuleSource, transformViteModuleSource } from "../../src/frameworks/vite-workflow-preview.ts";

const mainSource = [
  "import { StrictMode } from \"react\";",
  "import { createRoot } from \"react-dom/client\";",
  "import \"./index.css\";",
  "import \"./debug\";",
  "import App from \"./App.tsx\";",
  "",
  "createRoot(document.getElementById(\"root\")!).render(",
  "  <StrictMode>",
  "    <App />",
  "  </StrictMode>",
  ");",
  ""
].join("\n");

const cliModule = transformViteModuleSource("/src/main.tsx", mainSource, "vite-cli", (specifier) => {
  if (specifier === "react") return "/node_modules/react/index.js";
  if (specifier === "react-dom/client") return "/node_modules/react-dom/client.js";
  if (specifier === "react/jsx-runtime") return "/node_modules/react/jsx-runtime.js";
  return undefined;
});
assert.match(cliModule, /transformed by vite-cli/u);
assert.doesNotMatch(cliModule, /<StrictMode>/u);
assert.doesNotMatch(cliModule, /getElementById\("root"\)!/u);
assert.match(cliModule, /from "\.\.\/node_modules\/react\/jsx-runtime\.js"/u);
assert.match(cliModule, /from "\.\.\/node_modules\/react\/index\.js"/u);
assert.match(cliModule, /stylesheet/u);
assert.match(cliModule, /import "\.\/debug\.js"/u);
assertParseableModule(cliModule);

const registeredModule = browserPreviewModuleSource(
  "/src/main.tsx",
  `// transformed by vite-cli service:/src/main\n${mainSource}`
);
assert.match(registeredModule, /transformed by vite-cli service:\/src\/main/u);
assert.doesNotMatch(registeredModule, /<StrictMode>/u);
assertParseableModule(registeredModule);

const plainScript = transformViteModuleSource("/src/debug.js", "console.log(\"ok\");\n", "vite-cli");
assert.match(plainScript, /console\.log\("ok"\)/u);
assertParseableModule(plainScript);

console.log("vite preview module test ok");

function assertParseableModule(source: string): void {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-preview-module-")), "module.mjs");
  fs.writeFileSync(filePath, source);
  const checked = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
}
