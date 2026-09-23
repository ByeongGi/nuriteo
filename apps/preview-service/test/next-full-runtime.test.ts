import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import {
  createNextDependencyArtifactFromWorkspace,
  createNextPackageArtifactFromWorkspace,
  NextProductWorkflow
} from "../../../packages/node-runtime/src/index.ts";
import { createNodeFsWorkspaceReader } from "../../../tooling/shared/fs-workspace-reader.ts";

const require = createRequire(import.meta.url);
const nextRoot = dirname(realpathSync(require.resolve("next/package.json")));
const requireFromNext = createRequire(`${nextRoot}/package.json`);
const packageRoot = (name) => {
  try {
    return dirname(realpathSync(require.resolve(`${name}/package.json`)));
  } catch {
    try {
      return dirname(realpathSync(requireFromNext.resolve(`${name}/package.json`)));
    } catch {
      return dirname(realpathSync(require.resolve(name)));
    }
  }
};
const dependencyNames = [
  "@next/env",
  "@next/swc-wasm-nodejs",
  "@swc/counter",
  "@swc/helpers",
  "@types/node",
  "@types/react",
  "busboy",
  "caniuse-lite",
  "client-only",
  "nanoid",
  "picocolors",
  "postcss",
  "react",
  "react-dom",
  "scheduler",
  "source-map-js",
  "styled-jsx",
  "typescript"
];

const nextPackageArtifact = createNextPackageArtifactFromWorkspace({
  packageRoot: "/vendor/next",
  reader: createNodeFsWorkspaceReader({ root: nextRoot, virtualRoot: "/vendor/next" })
});
const dependencyArtifacts = dependencyNames.map((name) => {
  const root = packageRoot(name);
  return createNextDependencyArtifactFromWorkspace({
    name,
    packageRoot: "/vendor/dependency",
    reader: createNodeFsWorkspaceReader({ root, virtualRoot: "/vendor/dependency" })
  });
});

const workflow = new NextProductWorkflow({
  dependencyArtifacts,
  manager: "pnpm",
  nextPackageArtifact,
  port: 3045
});
workflow.install();

// Release the source artifact copies once the workflow has mounted them. This
// keeps the real-distribution test below its browser-worker memory budget.
nextPackageArtifact.mounts.length = 0;
for (const artifact of dependencyArtifacts) artifact.mounts.length = 0;

workflow.workspace.writeText(
  "/workspace/app/app/layout.js",
  "export default function RootLayout({ children }) { return <html><body>{children}</body></html> }"
);
workflow.workspace.writeText(
  "/workspace/app/app/page.js",
  "export default function Page() { return <main><h1>Full Next Runtime</h1></main> }"
);
workflow.workspace.remove("/workspace/app/app/layout.tsx");
workflow.workspace.remove("/workspace/app/app/page.tsx");
workflow.workspace.remove("/workspace/app/app/about/page.tsx");
workflow.workspace.remove("/workspace/app/tsconfig.json");

const dev = await workflow.startDevServerFromCliExecution();
assert.equal(dev.moduleTransform, "next-cli");
const devResponse = await workflow.fetch(`http://127.0.0.1:${dev.port}/`);
assert.equal(devResponse.status, 200);
assert.match(await devResponse.text(), /Full Next Runtime/);
workflow.stopDevServer();

workflow.workspace.writeText(
  "/workspace/app/middleware.js",
  "import { NextResponse } from 'next/server'; export function middleware(request) { const response = NextResponse.next(); response.headers.set('x-cargo-middleware', request.nextUrl.pathname); return response; } export const config = { matcher: ['/about'] };"
);
workflow.workspace.writeText(
  "/workspace/app/app/about/page.js",
  "export default function AboutPage() { return <main><h1>About Runtime</h1></main> }"
);
workflow.workspace.writeText(
  "/workspace/app/app/action/page.js",
  "import { redirect } from 'next/navigation'; export default function ActionPage() { async function submit() { 'use server'; redirect('/action?message=hello'); } return <form action={submit}><button type='submit'>Send</button></form>; }"
);
workflow.workspace.writeText(
  "/workspace/app/app/api/edge/route.js",
  "export const runtime = 'edge'; export async function GET() { return Response.json({ runtime: 'edge', ok: true }); }"
);
workflow.workspace.writeText(
  "/workspace/app/app/isr/page.js",
  "export const revalidate = 1; export default function IsrPage() { return <main><h1>ISR Page</h1><time>{Date.now()}</time></main>; }"
);
workflow.workspace.writeBytes(
  "/workspace/app/public/pixel.png",
  Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"))
);
workflow.workspace.writeText(
  "/workspace/app/app/image/page.js",
  "import Image from 'next/image'; export default function ImagePage() { return <main><Image src='/pixel.png' width={1} height={1} alt='pixel' /></main>; }"
);

const build = await workflow.buildFromCliExecution();
for (const file of [
  ".next/BUILD_ID",
  ".next/prerender-manifest.json",
  ".next/server/middleware-manifest.json",
  ".next/server/server-reference-manifest.json"
]) {
  assert.ok(build.files.includes(file), `missing native Next build artifact: ${file}`);
}
const prerenderManifest = JSON.parse(workflow.workspace.readText("/workspace/app/.next/prerender-manifest.json"));
assert.equal(prerenderManifest.routes["/isr"].initialRevalidateSeconds, 1);
const middlewareManifest = JSON.parse(workflow.workspace.readText("/workspace/app/.next/server/middleware-manifest.json"));
assert.ok(middlewareManifest.middleware["/"]);
assert.ok(middlewareManifest.functions["/api/edge/route"]);

const production = await workflow.startProductionServerFromCliExecution();
try {
  const origin = `http://127.0.0.1:${production.port}`;
  const about = await workflow.fetch(`${origin}/about`);
  assert.equal(about.status, 200);
  assert.equal(about.headers.get("x-cargo-middleware"), "/about");

  const edge = await workflow.fetch(`${origin}/api/edge`);
  assert.equal(edge.status, 200);
  assert.deepEqual(await edge.json(), { runtime: "edge", ok: true });

  const actionPage = await workflow.fetch(`${origin}/action`);
  const actionHtml = await actionPage.text();
  const actionId = /name="\$ACTION_ID_([^"]+)"/.exec(actionHtml)?.[1];
  assert.ok(actionId, "server action id was not rendered");
  const action = await workflow.fetch(`${origin}/action`, {
    body: "[]",
    headers: {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId
    },
    method: "POST"
  });
  assert.equal(action.status, 303);
  assert.equal(action.headers.get("x-action-redirect"), "/action?message=hello;push");

  await workflow.fetch(`${origin}/isr`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const isrFresh = await workflow.fetch(`${origin}/isr`);
  const freshBody = await isrFresh.text();
  assert.equal(isrFresh.headers.get("x-nextjs-cache"), "HIT");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const isrStale = await workflow.fetch(`${origin}/isr`);
  assert.equal(isrStale.headers.get("x-nextjs-cache"), "STALE");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const isrRegenerated = await workflow.fetch(`${origin}/isr`);
  assert.equal(isrRegenerated.headers.get("x-nextjs-cache"), "HIT");
  assert.notEqual(await isrRegenerated.text(), freshBody);

  const image = await workflow.fetch(`${origin}/_next/image?url=%2Fpixel.png&w=16&q=75`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  const imageBytes = new Uint8Array(await image.arrayBuffer());
  assert.ok(imageBytes.byteLength > 0);
  assert.deepEqual([...imageBytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
} finally {
  workflow.stopDevServer();
}

console.log("preview-service full Next.js runtime test ok");
