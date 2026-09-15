import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createViteDependencyArtifactFromWorkspace,
  createVitePackageArtifactFromWorkspace
} from "../../packages/node-runtime/src/index.ts";
import { createNodeFsWorkspaceReader } from "./fs-workspace-reader.mjs";

const root = mkdtempSync(join(tmpdir(), "cargo-container-fs-reader-"));
const viteRoot = join(root, "vite");
const dependencyRoot = join(root, "node_modules", "picomatch");
mkdirSync(join(viteRoot, "bin"), { recursive: true });
mkdirSync(join(viteRoot, "dist", "node"), { recursive: true });
mkdirSync(dependencyRoot, { recursive: true });
writeFileSync(
  join(viteRoot, "package.json"),
  JSON.stringify({ name: "vite", version: "8.2.0-fs-reader", type: "module", bin: { vite: "bin/vite.js" } })
);
writeFileSync(join(viteRoot, "bin", "vite.js"), "#!/usr/bin/env node\nimport '../dist/node/cli.js';\n");
writeFileSync(join(viteRoot, "dist", "node", "cli.js"), "export const cli = true;\n");
writeFileSync(
  join(dependencyRoot, "package.json"),
  JSON.stringify({ name: "picomatch", version: "4.0.5", type: "module", exports: { ".": "./index.js" } })
);
writeFileSync(join(dependencyRoot, "index.js"), "export default function picomatch(value) { return value; }\n");

const viteReader = createNodeFsWorkspaceReader({
  root: viteRoot,
  virtualRoot: "/vendor/vite"
});
assert.deepEqual(viteReader.listDir("/vendor/vite/bin"), ["vite.js"]);
assert.equal(viteReader.exists("/vendor/vite/package.json"), true);
assert.equal(viteReader.exists("/vendor/vite/missing.js"), false);
assert.throws(() => viteReader.readText("/vendor/other/package.json"), /outside virtual root/);

const viteArtifact = createVitePackageArtifactFromWorkspace({
  reader: viteReader,
  packageRoot: "/vendor/vite"
});
assert.equal(viteArtifact.version, "8.2.0-fs-reader");
assert.deepEqual(viteArtifact.mounts.map((mount) => mount.path), [
  "bin/vite.js",
  "dist/node/cli.js",
  "package.json"
]);

const modulesReader = createNodeFsWorkspaceReader({
  root: join(root, "node_modules"),
  virtualRoot: "/workspace/project/node_modules"
});
const dependencyArtifact = createViteDependencyArtifactFromWorkspace({
  reader: modulesReader,
  packageRoot: "/workspace/project/node_modules/picomatch"
});
assert.deepEqual(
  {
    name: dependencyArtifact.name,
    paths: dependencyArtifact.mounts.map((mount) => mount.path),
    version: dependencyArtifact.version
  },
  {
    name: "picomatch",
    paths: ["index.js", "package.json"],
    version: "4.0.5"
  }
);

console.log("vite filesystem workspace reader test ok");
