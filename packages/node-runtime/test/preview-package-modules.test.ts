import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { finishPreviewModule, previewJsonModuleSource, resolveInstalledPreviewSpecifier, ViteProductWorkflow } from "../src/frameworks/vite-workflow.ts";

const files = new Map<string, string>([
  ["/app/package.json", JSON.stringify({ name: "app", type: "module" })],
  ["/app/node_modules/ms/package.json", JSON.stringify({ name: "ms", version: "2.1.3", main: "index.js" })],
  ["/app/node_modules/ms/index.js", "module.exports = function ms(value) { return value; };\nmodule.exports.s = 1000;\n"],
  ["/app/node_modules/dep/package.json", JSON.stringify({ name: "dep", main: "index.js" })],
  ["/app/node_modules/dep/index.js", "module.exports = { value: 7 };\n"],
  ["/app/node_modules/pkg/package.json", JSON.stringify({ name: "pkg", main: "index.js" })],
  ["/app/node_modules/pkg/index.js", "const dep = require(\"dep\");\nconst meta = require(\"./data.json\");\nmodule.exports = { dep: dep, meta: meta };\n"],
  ["/app/node_modules/pkg/data.json", "{\"ok\":true}\n"],
  ["/app/node_modules/letters/package.json", JSON.stringify({
    name: "letters",
    type: "module",
    exports: { "./*": { import: "./*.js", default: "./*.js" } }
  })],
  ["/app/node_modules/letters/a.js", "export const letter = \"a\";\n"],
  ["/app/node_modules/date-fns/package.json", JSON.stringify({ name: "date-fns", type: "module", exports: { ".": "./index.js" } })],
  ["/app/node_modules/date-fns/index.js", "export function format() { return \"formatted\"; }\n"]
]);
const workspace = {
  exists(path: string) { return files.has(path); },
  isFile(path: string) { return files.has(path); },
  readText(path: string) { return files.get(path) ?? ""; }
};

assert.equal(resolveInstalledPreviewSpecifier("/app", "ms", workspace), "/node_modules/ms/index.js");
assert.equal(resolveInstalledPreviewSpecifier("/app", "letters/a", workspace), "/node_modules/letters/a.js");
assert.equal(resolveInstalledPreviewSpecifier("/app", "pkg/data.json", workspace), "/node_modules/pkg/data.json?nuriteo-module=json");

const msSource = finishPreviewModule("/node_modules/ms/index.js", files.get("/app/node_modules/ms/index.js") ?? "", undefined, {
  importerPath: "/app/node_modules/ms/index.js",
  projectRoot: "/app",
  workspace
});
assert.match(msSource, /export default __nuriteoDefault/u);
assert.match(msSource, /export const s = __nuriteoExports\.s/u);
assert.doesNotMatch(msSource, /^(?:import|export) /u);

const esmSource = finishPreviewModule("/node_modules/date-fns/index.js", files.get("/app/node_modules/date-fns/index.js") ?? "", undefined, {
  importerPath: "/app/node_modules/date-fns/index.js",
  projectRoot: "/app",
  workspace
});
assert.match(esmSource, /export function format/u);
assert.doesNotMatch(esmSource, /__nuriteoRequire/u);

const directory = mkdtempSync(join(tmpdir(), "nuriteo-preview-"));
const depUrl = pathToFileURL(join(directory, "dep.mjs"));
const jsonUrl = pathToFileURL(join(directory, "data.mjs"));
const pkgUrl = pathToFileURL(join(directory, "pkg.mjs"));
const msUrl = pathToFileURL(join(directory, "ms.mjs"));
writeFileSync(msUrl, msSource);
writeFileSync(jsonUrl, previewJsonModuleSource(files.get("/app/node_modules/pkg/data.json") ?? ""));
writeFileSync(depUrl, finishPreviewModule("/node_modules/dep/index.js", files.get("/app/node_modules/dep/index.js") ?? "", undefined, {
  importerPath: "/app/node_modules/dep/index.js",
  projectRoot: "/app",
  workspace
}));
const pkgSource = finishPreviewModule("/node_modules/pkg/index.js", files.get("/app/node_modules/pkg/index.js") ?? "", undefined, {
  importerPath: "/app/node_modules/pkg/index.js",
  projectRoot: "/app",
  workspace
})
  .replaceAll("\"/node_modules/dep/index.js\"", JSON.stringify(depUrl.href))
  .replaceAll("\"/node_modules/pkg/data.json?nuriteo-module=json\"", JSON.stringify(jsonUrl.href));
writeFileSync(pkgUrl, pkgSource);

const msModule = await import(msUrl.href);
const pkgModule = await import(pkgUrl.href);
assert.equal(msModule.default("5s"), "5s");
assert.equal(msModule.s, 1000);
assert.equal(pkgModule.default.dep.value, 7);
assert.equal(pkgModule.default.meta.ok, true);

const workflow = new ViteProductWorkflow({ manager: "npm" });
workflow.install();
workflow.workspace.writeText(`${workflow.projectRoot}/node_modules/clsx/dist/clsx.mjs`, "export function clsx() { return \"a\"; }\n");
workflow.workspace.writeText(`${workflow.projectRoot}/node_modules/ms/index.cjs`, "module.exports = function ms(value) { return value; };\n");
workflow.startDevServerFromPackageScript();
const mjs = workflow.preview("/node_modules/clsx/dist/clsx.mjs?nuriteo_hmr=2");
const cjs = workflow.preview("/node_modules/ms/index.cjs");
assert.equal(mjs.headers?.["content-type"], "text/javascript; charset=utf-8");
assert.equal(cjs.headers?.["content-type"], "text/javascript; charset=utf-8");
assert.match(String(mjs.body), /export function clsx/u);
assert.match(String(cjs.body), /export default __nuriteoDefault/u);
workflow.stopDevServer();

console.log("preview package modules ok");
