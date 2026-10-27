import assert from "node:assert/strict";

import { previewModuleRefreshPath, versionPreviewImportSpecifier } from "../../src/runtime/preview-import-version.ts";

assert.equal(
  versionPreviewImportSpecifier("/node_modules/clsx/dist/clsx.mjs", "3"),
  "/node_modules/clsx/dist/clsx.mjs?nuriteo_hmr=3"
);
assert.equal(
  versionPreviewImportSpecifier("/node_modules/pkg/data.json?nuriteo-module=json", "4"),
  "/node_modules/pkg/data.json?nuriteo-module=json&nuriteo_hmr=4"
);
assert.equal(versionPreviewImportSpecifier("./App.tsx", "5"), "./App.tsx?nuriteo_hmr=5");
assert.equal(versionPreviewImportSpecifier("ms", "5"), "ms");
assert.equal(previewModuleRefreshPath(["package.json", "src/App.tsx", "src/main.tsx"]), "src/main.tsx");
assert.equal(previewModuleRefreshPath(["package.json", "app/layout.tsx", "app/about/page.tsx", "app/page.tsx"]), "app/page.tsx");
assert.equal(previewModuleRefreshPath(["package.json", "pages/index.tsx"]), "pages/index.tsx");
assert.equal(previewModuleRefreshPath(["package.json", "app/about/page.tsx"]), "app/about/page.tsx");

console.log("preview import version ok");
