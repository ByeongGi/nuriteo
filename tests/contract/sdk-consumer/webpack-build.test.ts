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

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-webpack-consumer-"));
try {
  fs.writeFileSync(path.join(workdir, "package.json"), `${JSON.stringify({
    private: true,
    scripts: {
      build: "webpack --mode=production"
    },
    dependencies: {
      "@nuriteo/sdk": packageTarball,
      "ts-loader": "9.6.2",
      "typescript": "6.0.3",
      "webpack": "5.111.0",
      "webpack-cli": "7.2.3"
    }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(workdir, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      allowImportingTsExtensions: true,
      lib: ["ES2024", "DOM"],
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
      strict: true,
      target: "ES2024",
      types: []
    },
    include: ["src/**/*.ts"]
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(workdir, "webpack.config.cjs"), [
    "const path = require('node:path');",
    "",
    "module.exports = {",
    "  entry: './src/main.ts',",
    "  output: {",
    "    clean: true,",
    "    filename: 'bundle.js',",
    "    path: path.resolve(__dirname, 'dist')",
    "  },",
    "  resolve: {",
    "    extensions: ['.ts', '.js']",
    "  },",
    "  module: {",
    "    rules: [",
    "      {",
    "        test: /\\.ts$/,",
    "        loader: 'ts-loader',",
    "        options: { transpileOnly: true }",
    "      }",
    "    ]",
    "  }",
    "};",
    ""
  ].join("\n"));
  fs.mkdirSync(path.join(workdir, "src"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "src/main.ts"), [
    'import { createContainer, protocolVersion } from "@nuriteo/sdk";',
    "",
    "const container = createContainer({",
    '  systemWorkerUrl: new URL("/sdk/workers/system-worker.ts", globalThis.location.href),',
    '  processWorkerUrl: new URL("/sdk/workers/process-worker.ts", globalThis.location.href)',
    "});",
    "globalThis.__sdkWebpackSmoke = `${protocolVersion}:${container.status}`;",
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
  assert.equal(install.status, 0, `Webpack consumer install failed:\n${install.stdout}\n${install.stderr}`);

  const build = spawnSync("npm", ["run", "build"], {
    cwd: workdir,
    encoding: "utf8",
    timeout: 120000
  });
  assert.equal(build.status, 0, `Webpack consumer build failed:\n${build.stdout}\n${build.stderr}`);
  const bundle = fs.readFileSync(path.join(workdir, "dist/bundle.js"), "utf8");
  assert.match(bundle, /system-worker\.ts/);
  assert.match(bundle, /process-worker\.ts/);
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}

console.log("sdk consumer webpack build test ok");
