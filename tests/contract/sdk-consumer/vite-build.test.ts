import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../../..", import.meta.url).pathname;
const packageTarball = path.join(root, "dist/sdk/nuriteo-sdk-0.1.0-beta.1.tgz");

if (!fs.existsSync(packageTarball)) {
  throw new Error("SDK package tarball missing; run tooling/release/package-sdk.ts first");
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-vite-consumer-"));
try {
  fs.writeFileSync(path.join(workdir, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    scripts: {
      build: "vite build"
    },
    dependencies: {
      "@nuriteo/sdk": packageTarball,
      "vite": "8.2.0",
      "typescript": "6.0.3"
    },
    devDependencies: {}
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(workdir, "index.html"), [
    '<!doctype html>',
    '<html lang="en">',
    "  <head>",
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    "    <title>SDK Vite Consumer</title>",
    "  </head>",
    "  <body>",
    '    <div id="app"></div>',
    '    <script type="module" src="/src/main.ts"></script>',
    "  </body>",
    "</html>",
    ""
  ].join("\n"));
  fs.mkdirSync(path.join(workdir, "src"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "src/main.ts"), [
    'import { createContainer, createPreviewSessionRegistry, protocolVersion } from "@nuriteo/sdk";',
    "",
    "const container = createContainer({",
    '  systemWorkerUrl: new URL("/sdk/workers/system-worker.ts", import.meta.url),',
    '  processWorkerUrl: new URL("/sdk/workers/process-worker.ts", import.meta.url)',
    "});",
    "const sessions = createPreviewSessionRegistry();",
    'document.querySelector<HTMLDivElement>("#app")!.textContent = `${protocolVersion}:${container.status}:${typeof sessions.create}`;',
    ""
  ].join("\n"));

  const install = spawnSync("npm", [
    "install",
    "--cache",
    path.join(workdir, ".npm-cache"),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund"
  ], {
    cwd: workdir,
    encoding: "utf8",
    timeout: 120000
  });
  assert.equal(install.status, 0, `Vite consumer install failed:\n${install.stdout}\n${install.stderr}`);

  const build = spawnSync("npm", ["run", "build"], {
    cwd: workdir,
    encoding: "utf8",
    timeout: 120000
  });
  assert.equal(build.status, 0, `Vite consumer build failed:\n${build.stdout}\n${build.stderr}`);
  assert.equal(fs.existsSync(path.join(workdir, "dist/index.html")), true);

  const assets = fs.readdirSync(path.join(workdir, "dist/assets"));
  const jsAsset = assets.find((asset) => asset.endsWith(".js"));
  assert.ok(jsAsset, "Vite consumer build did not emit a JavaScript asset");
  const js = fs.readFileSync(path.join(workdir, "dist/assets", jsAsset), "utf8");
  assert.match(js, /system-worker\.ts/);
  assert.match(js, /process-worker\.ts/);
  assert.match(js, /protocolVersion|1/);
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}

console.log("sdk consumer vite build test ok");
