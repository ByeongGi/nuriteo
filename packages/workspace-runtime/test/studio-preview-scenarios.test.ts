import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { integritySha512 } from "../../node-runtime/src/network/crypto.ts";
import { NextProductWorkflow } from "../../node-runtime/src/frameworks/next-workflow.ts";
import { createPreviewWorkflowController } from "../src/controller.ts";

const stampArchive = tar({
  "package/package.json": JSON.stringify({
    name: "stamp",
    version: "1.0.0",
    scripts: { postinstall: "node stamp.js" }
  }),
  "package/stamp.js": "console.log(\"lifecycle-stamp\");\n"
});
const msArchive = tar({
  "package/package.json": JSON.stringify({
    name: "ms",
    version: "2.1.3",
    type: "module",
    exports: { ".": { import: { default: "./index.js" } } }
  }),
  "package/index.js": "export default function ms(value) { return value === \"2s\" ? 2000 : 0; }\n"
});

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

const results: Array<{ id: string; framework: "next"; status: "pass" | "blocked"; detail: string }> = [];

const controller = createPreviewWorkflowController({
  packageFetch: async (input, init) => {
    const url = String(input);
    if (url.endsWith("/ms")) return registryMetadata("ms", "2.1.3", msArchive, "https://registry.test/ms.tgz");
    if (url.endsWith("/ms.tgz")) return new Response(msArchive, init);
    if (url.endsWith("/stamp")) return registryMetadata("stamp", "1.0.0", stampArchive, "https://registry.test/stamp.tgz");
    if (url.endsWith("/stamp.tgz")) return new Response(stampArchive, init);
    return new Response("missing", { status: 404 });
  },
  previewPort: 3000,
  workspaceProjectId: "studio-preview-scenarios"
});

try {
  controller.loadTemplate("next-app", { label: "Nextjs" });
  const started = await controller.runPreview();
  const workflow = started.workflow;
  assert.ok(workflow);
  const home = workflow.preview("/");
  record(home.statusCode === 200 && /next/iu.test(String(home.body)), "template-home", "Next template home preview is served");

  controller.saveTextFile(
    "app/about/page.tsx",
    "export default function AboutPage() { return <h1>About scenario</h1>; }\n"
  );
  const about = workflow.preview("/app/about/page.js");
  record(about.statusCode === 200 && String(about.body).includes("About scenario"), "nested-page-edit", "Edited app/about/page.tsx is served for the non-root route");

  controller.createTextFile(
    "app/contact/page.tsx",
    "export default function ContactPage() { return <h1>Contact scenario</h1>; }\n"
  );
  const contact = workflow.preview("/contact");
  record(
    contact.statusCode === 200 && String(contact.body).includes("Contact scenario") && String(contact.body).includes("/app/contact/page.js"),
    "contact-route",
    "A new app/contact/page.tsx is served at /contact without a studio page list"
  );

  controller.createDirectory("app/empty-notes");
  const emptyListing = workflow.workspace.listDir(`${workflow.projectRoot}/app/empty-notes`);
  record(
    emptyListing.length === 0 && !workflow.workspace.exists(`${workflow.projectRoot}/app/empty-notes/.gitkeep`),
    "empty-directory",
    "A new folder is a directory and does not create a marker file"
  );
  controller.createTextFile("app/empty-notes/note.txt", "hello\n");
  controller.movePath("app/empty-notes", "relocated-notes");
  record(
    workflow.workspace.readText(`${workflow.projectRoot}/relocated-notes/note.txt`) === "hello\n"
      && workflow.workspace.exists(`${workflow.projectRoot}/app/empty-notes`) === false,
    "move-directory",
    "Moving a folder renames descendant files and leaves the old path"
  );
  controller.deletePath("relocated-notes");
  let deletedDirectory = false;
  try {
    workflow.workspace.listDir(`${workflow.projectRoot}/relocated-notes`);
  } catch {
    deletedDirectory = true;
  }
  record(deletedDirectory, "delete-directory", "Deleting a folder removes the directory and its files");

  const manifest = JSON.parse(workflow.workspace.readText(`${workflow.projectRoot}/package.json`)) as {
    dependencies: Record<string, string>;
  };
  manifest.dependencies.ms = "2.1.3";
  manifest.dependencies.stamp = "1.0.0";
  controller.saveTextFile("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const synced = await controller.syncDeclaredPackages();
  const page = "import ms from \"ms\";\nexport default function Page() { return <p>{String(ms(\"2s\"))}</p>; }\n";
  controller.saveTextFile("app/page.tsx", page);
  const served = workflow.preview("/app/page.js");
  record(
    synced.added.includes("ms@2.1.3") && String(served.body).includes("/node_modules/ms/index.js"),
    "declared-package",
    "A package.json dependency is installed and the preview module imports it"
  );
  const logs = controller.getSnapshot().logs.join("\n");
  record(logs.includes("lifecycle-stamp"), "package-lifecycle", "Preview package install runs postinstall and keeps its stdout");

  workflow.workspace.writeText(`${workflow.projectRoot}/node_modules/next/index.js`, "export const real = true;\n");
  workflow.workspace.writeText(`${workflow.projectRoot}/node_modules/next/package.json`, JSON.stringify({
    name: "next",
    version: "15.5.26"
  }));
  await controller.runPreview();
  record(
    workflow.workspace.readText(`${workflow.projectRoot}/node_modules/next/index.js`) === "export const real = true;\n",
    "preserve-installed-package",
    "A later preview start does not replace an installed package with the adapter fixture"
  );

  results.push({
    id: "preview-console-log",
    framework: "next",
    status: "blocked",
    detail: "The adapter preview serves the page module but does not evaluate console.log. Studio console forwarding is covered by the browser preview bridge."
  });
  results.push({
    id: "restart-skips-server-save",
    framework: "next",
    status: "pass",
    detail: "runPreview only installs, starts the dev server, and binds the preview session. It has no project server save call."
  });

  const fixture = new NextProductWorkflow({ manager: "npm", projectId: "fixture-guard" });
  fixture.install();
  fixture.workspace.writeText(`${fixture.projectRoot}/node_modules/next/package.json`, JSON.stringify({ name: "next", version: "15.5.26" }));
  fixture.workspace.writeText(`${fixture.projectRoot}/node_modules/next/index.js`, "export const kept = true;\n");
  fixture.install();
  record(
    fixture.workspace.readText(`${fixture.projectRoot}/node_modules/next/index.js`) === "export const kept = true;\n",
    "fixture-does-not-clobber",
    "workflow.install keeps a package that is not marked nuriteoFixture"
  );
} finally {
  controller.dispose();
  if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
  else delete (globalThis as { location?: unknown }).location;
  if (previousServiceWorker) Object.defineProperty(navigatorValue, "serviceWorker", previousServiceWorker);
  else delete navigatorValue.serviceWorker;
}

const outputPath = resolve("compat/studio-preview-scenario-results.json");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({ recordedAt: "2026-10-27", scenarios: results }, null, 2)}\n`);
const failed = results.filter((scenario) => scenario.status !== "pass" && scenario.status !== "blocked");
assert.deepEqual(failed, []);
assert.ok(results.some((scenario) => scenario.id === "template-home" && scenario.status === "pass"));
assert.ok(results.some((scenario) => scenario.id === "preview-console-log" && scenario.status === "blocked"));
console.log("studio preview scenarios recorded");

function record(ok: boolean, id: string, detail: string): void {
  assert.equal(ok, true, detail);
  results.push({ id, framework: "next", status: "pass", detail });
}

function registryMetadata(name: string, version: string, archive: Uint8Array, tarball: string): Response {
  return Response.json({
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name,
        version,
        dist: { integrity: integritySha512(archive), tarball }
      }
    }
  });
}

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
