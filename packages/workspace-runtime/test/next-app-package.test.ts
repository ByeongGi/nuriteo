import assert from "node:assert/strict";

import { integritySha512 } from "../../node-runtime/src/network/crypto.ts";
import { createPreviewWorkflowController } from "../src/controller.ts";

const archive = tar({
  "package/package.json": JSON.stringify({
    name: "ms",
    version: "2.1.3",
    type: "module",
    exports: { ".": { import: { default: "./index.js" } } }
  }),
  "package/index.js": "export default function ms(value) { return value === \"2s\" ? 2000 : 0; }\n"
});
const fetched: string[] = [];
const packageFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  fetched.push(url);
  if (url.endsWith("/ms")) {
    return Response.json({
      "dist-tags": { latest: "2.1.3" },
      versions: {
        "2.1.3": {
          name: "ms",
          version: "2.1.3",
          dist: { integrity: integritySha512(archive), tarball: "https://registry.test/ms.tgz" }
        }
      }
    });
  }
  if (url.endsWith("/ms.tgz")) return new Response(archive, init);
  return new Response("missing", { status: 404 });
};

const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { origin: "http://127.0.0.1:3000" }
});
const navigatorValue = globalThis.navigator as Navigator & { serviceWorker?: unknown };
const previousServiceWorker = Object.getOwnPropertyDescriptor(navigatorValue, "serviceWorker");
Object.defineProperty(navigatorValue, "serviceWorker", {
  configurable: true,
  value: {
    addEventListener() {},
    removeEventListener() {},
    async register() { return {}; },
    ready: Promise.resolve({})
  }
});

const controller = createPreviewWorkflowController({
  packageFetch,
  previewPort: 3000,
  workspaceProjectId: "next-app-package"
});

try {
  controller.loadTemplate("next-app", { label: "Nextjs" });
  const started = await controller.runPreview();
  assert.equal(started.phase, "hmr_connected");
  assert.equal(started.lastError, null);
  assert.deepEqual(fetched, []);

  const workflow = started.workflow;
  assert.ok(workflow);
  const manifest = JSON.parse(workflow.workspace.readText(`${workflow.projectRoot}/package.json`)) as {
    dependencies: Record<string, string>;
  };
  manifest.dependencies.ms = "2.1.3";
  controller.saveTextFile("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const synced = await controller.syncDeclaredPackages();
  assert.deepEqual(synced.added, ["ms@2.1.3"]);
  assert.deepEqual(fetched.map((url) => new URL(url).pathname), ["/ms", "/ms.tgz"]);

  controller.saveTextFile(
    "app/page.tsx",
    "import ms from \"ms\";\nexport default function Page() { return <p>{String(ms(\"2s\"))}</p>; }\n"
  );
  const served = workflow.preview("/app/page.js");
  assert.equal(served.statusCode, 200);
  assert.match(String(served.body), /from "\/node_modules\/ms\/index\.js"/u);
  const home = workflow.preview("/");
  assert.equal(home.statusCode, 200);
  assert.match(String(home.body), /Nextjs|next/iu);
} finally {
  controller.dispose();
  if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
  else delete (globalThis as { location?: unknown }).location;
  if (previousServiceWorker) Object.defineProperty(navigatorValue, "serviceWorker", previousServiceWorker);
  else delete navigatorValue.serviceWorker;
}

console.log("next app declared package preview ok");

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
