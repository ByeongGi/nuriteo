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

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-next-consumer-"));
try {
  fs.writeFileSync(path.join(workdir, "package.json"), `${JSON.stringify({
    private: true,
    scripts: {
      build: "next build"
    },
    dependencies: {
      "@nuriteo/sdk": packageTarball,
      "next": "16.3.5",
      "react": "19.3.0",
      "react-dom": "19.3.0"
    }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(workdir, "next.config.mjs"), [
    "const nextConfig = {",
    "  transpilePackages: ['@nuriteo/sdk']",
    "};",
    "",
    "export default nextConfig;",
    ""
  ].join("\n"));
  fs.mkdirSync(path.join(workdir, "app"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "app/layout.jsx"), [
    "export const metadata = { title: 'SDK Next Consumer' };",
    "",
    "export default function RootLayout({ children }) {",
    "  return (",
    "    <html lang=\"en\">",
    "      <body>{children}</body>",
    "    </html>",
    "  );",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(workdir, "app/page.jsx"), [
    '"use client";',
    "",
    'import { createContainer, protocolVersion } from "@nuriteo/sdk";',
    "",
    "export default function Page() {",
    "  const status = typeof window === 'undefined'",
    "    ? 'server'",
    "    : createContainer({",
    "        systemWorkerUrl: new URL('/sdk/workers/system-worker.ts', globalThis.location.href),",
    "        processWorkerUrl: new URL('/sdk/workers/process-worker.ts', globalThis.location.href)",
    "      }).status;",
    "  return <main id=\"app\">{protocolVersion}:{status}</main>;",
    "}",
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
  assert.equal(install.status, 0, `Next consumer install failed:\n${install.stdout}\n${install.stderr}`);

  const build = spawnSync("npm", ["run", "build"], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1"
    },
    timeout: 180000
  });
  assert.equal(build.status, 0, `Next consumer build failed:\n${build.stdout}\n${build.stderr}`);
  assert.equal(fs.existsSync(path.join(workdir, ".next")), true);

  const staticFiles = listFiles(path.join(workdir, ".next"));
  const clientAsset = staticFiles
    .filter((file) => file.endsWith(".js"))
    .find((file) => fs.readFileSync(file, "utf8").includes("system-worker.ts"));
  assert.ok(clientAsset, "Next consumer build did not preserve SDK worker URL string in client assets");
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}

console.log("sdk consumer next build test ok");

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}
