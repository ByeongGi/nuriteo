import assert from "node:assert/strict";

import { visibleStudioExplorerFiles } from "../../src/projects/studio/explorer-files.ts";

const files = [
  { path: "package.json" },
  { path: "src/main.tsx" },
  { path: "node_modules/left-pad/index.js" },
  { path: "node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js" },
  { path: ".pnpm-store/v10/files/00/hash" },
  { path: "packages/web/node_modules/react/index.js" },
  { path: "docs/node-modules-notes.md" }
];

assert.deepEqual(visibleStudioExplorerFiles(files).map((file) => file.path), [
  "package.json",
  "src/main.tsx",
  "docs/node-modules-notes.md"
]);

console.log("studio explorer hides npm and pnpm install trees");
