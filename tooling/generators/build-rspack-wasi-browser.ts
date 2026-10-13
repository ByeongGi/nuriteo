#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { build } from "vite";

const repositoryRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve("@rspack/binding-wasm32-wasi/package.json"));
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
assert.equal(packageJson.version, "2.2.4");

const outputRoot = path.join(repositoryRoot, "packages/workspace-runtime/assets/vendor/rspack-2.2.4");
const sharedBufferDecoderPlugin = {
  name: "nuriteo-rspack-copy-shared-textdecoder-input",
  enforce: "pre" as const,
  transform(source: string, id: string) {
    const wasiLogDecode = "new TextDecoder().decode(buffer.subarray(lastBegin, index))";
    if (id.includes("/@tybys/wasm-util/") && source.includes(wasiLogDecode)) {
      return source.replaceAll(wasiLogDecode, "new TextDecoder().decode(new Uint8Array(buffer.subarray(lastBegin, index)))");
    }
    if (id.includes("/@tybys/wasm-util/") && /\/wasi\/util\.(?:mjs|js)$/.test(id)) {
      const sharedSlice = "? view.slice(start, end)";
      assert.ok(source.includes(sharedSlice), "unexpected Rspack WASI unsharedSlice source");
      return source.replace(sharedSlice, "? new Uint8Array(view.subarray(start, end))");
    }
    if (!id.endsWith("/@napi-rs/wasm-runtime/fs-proxy.js")) return null;
    const expression = "new TextDecoder().decode(payload.slice())";
    assert.ok(source.includes(expression), "unexpected Rspack fs-proxy decoder source");
    return source.replaceAll(expression, "new TextDecoder().decode(new Uint8Array(payload))");
  }
};
await build({
  base: "/vendor/rspack-2.2.4/",
  configFile: false,
  publicDir: false,
  root: packageRoot,
  plugins: [sharedBufferDecoderPlugin, {
    name: "nuriteo-rspack-wasi-static-assets",
    enforce: "pre",
    transform(source, id) {
      if (id !== path.join(packageRoot, "rspack.wasi-browser.js")) return null;
      const wasmExpression = "new URL('./rspack.wasm32-wasi.wasm', import.meta.url).href";
      const workerExpression = "new URL('./wasi-worker-browser.mjs', import.meta.url)";
      const workerErrorHandler = `    worker.addEventListener('error', (event) => {
      if (event.data && typeof event.data === 'object' && event.data.type === 'error') {
        window.dispatchEvent(new CustomEvent('napi-rs-worker-error', { detail: event.data }))
      }
    })`;
      assert.equal(source.split(wasmExpression).length - 1, 1, "unexpected Rspack WASM URL expression");
      assert.equal(source.split(workerExpression).length - 1, 1, "unexpected Rspack worker URL expression");
      assert.equal(source.split(workerErrorHandler).length - 1, 1, "unexpected Rspack worker error handler");
      return source
        .replace(wasmExpression, JSON.stringify("/vendor/rspack-2.2.4/assets/rspack.wasm"))
        .replace(workerExpression, "new URL('/vendor/rspack-2.2.4/assets/wasi-worker-browser.mjs', self.location.href)")
        .replace(workerErrorHandler, `    worker.addEventListener('message', (event) => {
    if (event.data && typeof event.data === 'object' && event.data.type === 'error') {
      console.error('[rspack-wasi-worker]', event.data.error || event.data)
    }
  })
  worker.addEventListener('error', (event) => {
    console.error('[rspack-wasi-worker]', event.error || event.message || event)
  })`);
    }
  }],
  build: {
    assetsInlineLimit: 0,
    emptyOutDir: true,
    lib: {
      entry: path.join(packageRoot, "rspack.wasi-browser.js"),
      fileName: "rspack-wasi-binding",
      formats: ["es"]
    },
    outDir: outputRoot,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].mjs",
        entryFileNames: "rspack-wasi-binding.mjs"
      }
    }
  }
});

await build({
  base: "/vendor/rspack-2.2.4/",
  configFile: false,
  publicDir: false,
  root: packageRoot,
  plugins: [sharedBufferDecoderPlugin],
  build: {
    emptyOutDir: false,
    lib: { entry: path.join(packageRoot, "wasi-worker-browser.mjs"), fileName: "wasi-worker-browser", formats: ["es"] },
    outDir: path.join(outputRoot, "assets"),
    sourcemap: false,
    target: "es2022",
    rollupOptions: { output: { entryFileNames: "wasi-worker-browser.mjs" } }
  }
});

for (const generated of [
  path.join(outputRoot, "rspack-wasi-binding.mjs"),
  path.join(outputRoot, "assets/wasi-worker-browser.mjs")
]) {
  let source = fs.readFileSync(generated, "utf8");
  const expression = "? e.slice(t, n) : e.subarray(t, n)";
  assert.equal(source.split(expression).length - 1, 1, `unexpected WASI unsharedSlice output: ${generated}`);
  source = source.replace(expression, "? new Uint8Array(e.subarray(t, n)) : e.subarray(t, n)");
  source = `const __NuriteoNativeTextDecoder = globalThis.TextDecoder;
class TextDecoder extends __NuriteoNativeTextDecoder {
  decode(input, options) {
    const sharedView = input && ArrayBuffer.isView(input) && (input.buffer instanceof SharedArrayBuffer || Object.prototype.toString.call(input.buffer) === "[object SharedArrayBuffer]");
    const sharedBuffer = input && (input instanceof SharedArrayBuffer || Object.prototype.toString.call(input) === "[object SharedArrayBuffer]");
    if (sharedView || sharedBuffer) {
      input = new Uint8Array(sharedBuffer ? new Uint8Array(input) : input);
    }
    return super.decode(input, options);
  }
}
${source}`;
  source = normalizeGeneratedText(source);
  fs.writeFileSync(generated, source);
}

fs.mkdirSync(path.join(outputRoot, "assets"), { recursive: true });
fs.copyFileSync(path.join(packageRoot, "rspack.wasm32-wasi.wasm"), path.join(outputRoot, "assets/rspack.wasm"));

const files = walkFiles(outputRoot).map((file) => ({
  path: path.relative(repositoryRoot, file),
  bytes: fs.statSync(file).size,
  sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}));
fs.writeFileSync(path.join(outputRoot, "asset-manifest.json"), `${JSON.stringify({ version: packageJson.version, files }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ version: packageJson.version, files }, null, 2)}\n`);

function walkFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(file) : [file];
  }).sort();
}

function normalizeGeneratedText(value: string): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line
      .replace(/^[\t ]+/, (indentation) => indentation.replace(/ +(?=\t)/g, ""))
      .replace(/[\t ]+$/g, ""))
    .join("\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}
