import assert from "node:assert/strict";

import { integritySha512 } from "../../node-runtime/src/network/crypto.ts";
import { createPreviewWorkflowController } from "../src/controller.ts";

const archive = tar({
  "package/package.json": JSON.stringify({
    name: "browser-answer",
    version: "1.0.0",
    bin: { answer: "cli.cjs" },
    scripts: { postinstall: "node postinstall.cjs" }
  }),
  "package/cli.cjs": "#!/usr/bin/env node\nconsole.log('answer:42');\n",
  "package/postinstall.cjs": "const fs = require('node:fs');\nfs.writeFileSync('installed.txt', 'lifecycle-ready');\nconsole.log('postinstall:ready');\n"
});
const nativeArchive = tar({
  "package/package.json": JSON.stringify({
    name: "browser-native-addon",
    version: "1.0.0",
    scripts: { install: "node-gyp rebuild" }
  })
});

const packageFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/browser-native-addon")) {
    return Response.json({
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "browser-native-addon",
          version: "1.0.0",
          dist: {
            integrity: integritySha512(nativeArchive),
            tarball: "https://registry.test/browser-native-addon.tgz"
          }
        }
      }
    });
  }
  if (url.endsWith("/browser-answer")) {
    return Response.json({
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "browser-answer",
          version: "1.0.0",
          dist: {
            integrity: integritySha512(archive),
            tarball: "https://registry.test/browser-answer.tgz"
          }
        }
      }
    });
  }
  if (url === "https://registry.test/browser-answer.tgz") return new Response(archive);
  if (url === "https://registry.test/browser-native-addon.tgz") return new Response(nativeArchive);
  return new Response("not found", { status: 404 });
};

const controller = createPreviewWorkflowController({ packageFetch });
controller.loadViteReactTemplate();
controller.createTextFile(
  "scripts/direct-node.cjs",
  "const fs = require('node:fs');\nfs.writeFileSync('direct-node.txt', process.argv[2]);\nconsole.log('direct:' + process.argv[2]);\n"
);
const directNode = await controller.runShellCommand(
  "node scripts/direct-node.cjs browser",
  "registry-terminal"
);
assert.equal(directNode.exitCode, 0, directNode.stderr);
assert.equal(directNode.stdout, "direct:browser\n");
assert.equal(controller.getSnapshot().project!.readText("direct-node.txt"), "browser");
const install = await controller.runShellCommand("pnpm add browser-answer@1.0.0", "registry-terminal");
assert.equal(install.exitCode, 0, install.stderr);
assert.match(install.stdout, /added browser-answer@1\.0\.0/u);
assert.match(install.stdout, /postinstall:ready/u);
assert.equal(
  controller.getSnapshot().workflow!.workspace.readText("/workspace/app/node_modules/browser-answer/installed.txt"),
  "lifecycle-ready"
);

const manifest = JSON.parse(controller.getSnapshot().project!.readText("package.json"));
assert.equal(manifest.dependencies["browser-answer"], "1.0.0");
manifest.scripts.answer = "answer";
controller.saveTextFile("package.json", `${JSON.stringify(manifest, null, 2)}\n`);

const executed = await controller.runShellCommand("pnpm run answer", "registry-terminal");
assert.equal(executed.exitCode, 0, executed.stderr);
assert.equal(executed.stdout, "answer:42\n");
assert.equal(
  controller.getSnapshot().workflow!.workspace.readText("/workspace/app/node_modules/browser-answer/package.json"),
  JSON.stringify({
    name: "browser-answer",
    version: "1.0.0",
    bin: { answer: "cli.cjs" },
    scripts: { postinstall: "node postinstall.cjs" }
  })
);
controller.dispose();

const nativeController = createPreviewWorkflowController({ packageFetch });
nativeController.loadViteReactTemplate();
const nativeInstall = await nativeController.runShellCommand(
  "pnpm add browser-native-addon@1.0.0",
  "native-registry-terminal"
);
assert.equal(nativeInstall.exitCode, 1);
assert.match(nativeInstall.stderr, /native addon lifecycle is unsupported in the browser runtime/u);
const ignoredNativeInstall = await nativeController.runShellCommand(
  "pnpm add browser-native-addon@1.0.0 --ignore-scripts",
  "native-registry-terminal"
);
assert.equal(ignoredNativeInstall.exitCode, 0, ignoredNativeInstall.stderr);
nativeController.dispose();

const dateFnsArchive = tar({
  "package/package.json": JSON.stringify({
    name: "date-fns",
    version: "4.4.0",
    type: "module",
    module: "index.js",
    exports: { ".": { import: { default: "./index.js" } } }
  }),
  "package/index.js": "export function format() { return \"formatted\"; }\n"
});
const dateFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/date-fns")) {
    return Response.json({
      "dist-tags": { latest: "4.4.0" },
      versions: {
        "4.4.0": {
          name: "date-fns",
          version: "4.4.0",
          dist: {
            integrity: integritySha512(dateFnsArchive),
            tarball: "https://registry.test/date-fns.tgz"
          }
        }
      }
    });
  }
  if (url.endsWith("/date-fns.tgz")) return new Response(dateFnsArchive);
  return new Response("missing", { status: 404 });
};
const dateController = createPreviewWorkflowController({ packageFetch: dateFetch });
dateController.loadViteReactTemplate();
const dateManifest = JSON.parse(dateController.getSnapshot().project!.readText("package.json"));
dateManifest.dependencies["date-fns"] = "4.4.0";
dateController.saveTextFile("package.json", `${JSON.stringify(dateManifest, null, 2)}\n`);
const dateInstall = await dateController.runShellCommand("npm install", "date-fns-terminal");
assert.equal(dateInstall.exitCode, 0, dateInstall.stderr);
assert.equal(
  JSON.parse(dateController.getSnapshot().workflow!.workspace.readText("/workspace/app/node_modules/date-fns/package.json")).version,
  "4.4.0"
);
dateController.saveTextFile("src/App.tsx", "import { format } from \"date-fns\";\nexport default function App() { return format(new Date(), \"yyyy\"); }\n");
const dateWorkflow = dateController.getSnapshot().workflow!;
dateWorkflow.startDevServerFromPackageScript("dev");
const served = dateWorkflow.preview("/src/App.tsx");
assert.equal(served.statusCode, 200);
assert.match(String(served.body), /from "\/node_modules\/date-fns\/index\.js"/u);
delete dateManifest.dependencies["date-fns"];
dateManifest.devDependencies = { ...(dateManifest.devDependencies ?? {}), "date-fns": "4.4.0" };
dateController.saveTextFile("package.json", `${JSON.stringify(dateManifest, null, 2)}\n`);
const devDependencyInstall = await dateController.runShellCommand("npm install", "date-fns-dev-terminal");
assert.equal(devDependencyInstall.exitCode, 0, devDependencyInstall.stderr);
assert.equal(
  JSON.parse(dateController.getSnapshot().workflow!.workspace.readText("/workspace/app/node_modules/date-fns/package.json")).version,
  "4.4.0"
);
const devServed = dateWorkflow.preview("/src/App.tsx");
assert.match(String(devServed.body), /from "\/node_modules\/date-fns\/index\.js"/u);
dateController.dispose();

console.log("workspace registry package shell journey ok");

function tar(files: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(files)) {
    const body = new TextEncoder().encode(value);
    const header = new Uint8Array(512);
    write(header, 0, 100, name);
    write(header, 100, 8, "0000644\0");
    write(header, 108, 8, "0000000\0");
    write(header, 116, 8, "0000000\0");
    write(header, 124, 12, `${body.length.toString(8).padStart(11, "0")}\0`);
    write(header, 136, 12, "00000000000\0");
    header.fill(32, 148, 156);
    header[156] = "0".charCodeAt(0);
    write(header, 257, 6, "ustar\0");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function write(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}
