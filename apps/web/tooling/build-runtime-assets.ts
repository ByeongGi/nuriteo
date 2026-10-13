import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(webRoot, "../..");
const defaultOutputRoot = path.join(webRoot, "public/runtime");
const outputRoot = resolveOutputRoot(process.argv.slice(2));
const runtimeAssetSource = path.join(repositoryRoot, "packages/workspace-runtime/assets");

const entries = Object.freeze({
  "system-worker.js": path.join(repositoryRoot, "workers/system-worker.ts"),
  "process-worker.js": path.join(repositoryRoot, "workers/process-worker.ts"),
  "cli-nested-worker.js": path.join(repositoryRoot, "workers/cli-nested-worker.ts")
});

const assets = new Map<string, Uint8Array>();
const rewrittenRolldown = rewriteRolldownBinding(readText(path.join(
  runtimeAssetSource,
  "vendor/vite-8.2.0/rolldown-wasi-binding.mjs"
)));
const rewrittenRolldownHash = sha256(rewrittenRolldown);

for (const [name, entry] of Object.entries(entries)) {
  const result = await build({
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    minify: true,
    platform: "browser",
    sourcemap: false,
    target: "es2022",
    write: false,
    plugins: name === "process-worker.js"
      ? [processWorkerAssetPlugin(rewrittenRolldownHash)]
      : name === "cli-nested-worker.js"
        ? [cliNestedWorkerAssetPlugin()]
        : []
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`runtime worker bundle missing: ${name}`);
  assets.set(name, output.contents);
}

function cliNestedWorkerAssetPlugin(): Plugin {
  return {
    name: "nuriteo-runtime-nested-asset-paths",
    setup(buildContext) {
      buildContext.onLoad({ filter: /workers\/cli-nested-worker\.ts$/ }, (input) => ({
        contents: replaceRequired(readText(input.path), 'new URL("../vendor/', 'new URL("./vendor/'),
        loader: "ts"
      }));
    }
  };
}

assets.set("preview-sw.js", readBytes(path.join(runtimeAssetSource, "preview-sw.js")));
assets.set("system.wasm", readBytes(path.join(runtimeAssetSource, "runtime/system_wasm.wasm")));
assets.set("vendor/next-cli-15.5.26.mjs", readBytes(path.join(runtimeAssetSource, "vendor/next-cli-15.5.26.mjs")));
copyTree(path.join(runtimeAssetSource, "vendor/vite-8.2.0"), "vendor/vite-8.2.0");
assets.set("vendor/vite-8.2.0/rolldown-wasi-binding.mjs", rewrittenRolldown);

const files = [...assets]
  .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  .map(([assetPath, bytes]) => ({ path: assetPath, sha256: sha256(bytes), sizeBytes: bytes.byteLength }));
const revision = sha256(Buffer.from(JSON.stringify(files)));
const revisionRoot = path.join(outputRoot, revision);

fs.rmSync(outputRoot, { force: true, recursive: true });
for (const [assetPath, bytes] of assets) {
  const destination = path.join(revisionRoot, assetPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
}

const manifest = {
  schemaVersion: 1,
  revision,
  files
};
fs.mkdirSync(outputRoot, { recursive: true });
fs.writeFileSync(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`runtime assets ${revision} (${files.length} files)`);

function processWorkerAssetPlugin(rolldownHash: string): Plugin {
  return {
    name: "nuriteo-runtime-asset-paths",
    setup(buildContext) {
      buildContext.onLoad({ filter: /workers\/process-worker\.ts$/ }, (input) => {
        let source = readText(input.path);
        source = replaceRequired(source,
          'new URL(url || "/runtime/system_wasm.wasm", self.location.origin)',
          'new URL(url || "./system.wasm", self.location.href)');
        source = replaceRequired(source,
          'new URL("./cli-nested-worker.ts", import.meta.url)',
          'new URL("./cli-nested-worker.js", import.meta.url)');
        source = replaceRequired(source,
          'new URL(`/vendor/${lane}-${expected.version}/`, self.location.origin)',
          'new URL(`./vendor/${lane}-${expected.version}/`, self.location.href)');
        source = replaceRequired(source, 'new URL("../vendor/', 'new URL("./vendor/', 3);
        source = replaceRegexRequired(
          source,
          /const ROLLDOWN_WASI_BINDING_SHA256 = "[0-9a-f]{64}";/u,
          `const ROLLDOWN_WASI_BINDING_SHA256 = "${rolldownHash}";`
        );
        return { contents: source, loader: "ts" };
      });
    }
  };
}

function rewriteRolldownBinding(source: string): Uint8Array {
  let text = replaceRequired(
      source,
      'Sc = "/vendor/vite-8.2.0/assets/rolldown-binding.wasm"',
      'Sc = new URL("./assets/rolldown-binding.wasm", import.meta.url).href'
    );
  text = replaceRequired(
      text,
      '"/vendor/vite-8.2.0/assets/wasi-worker-browser-IL7bwx-u.js",',
      '"./assets/wasi-worker-browser-IL7bwx-u.js",'
    );
  return new TextEncoder().encode(text);
}

function replaceRequired(source: string, search: string, replacement: string, expectedCount = 1): string {
  const count = source.split(search).length - 1;
  if (count !== expectedCount) {
    throw new Error(`runtime asset rewrite mismatch: expected ${expectedCount}, observed ${count}`);
  }
  return source.split(search).join(replacement);
}

function replaceRegexRequired(source: string, search: RegExp, replacement: string): string {
  const matches = [...source.matchAll(new RegExp(search.source, `${search.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`runtime asset rewrite mismatch: expected one integrity constant, observed ${matches.length}`);
  }
  return source.replace(search, replacement);
}

function copyTree(sourceRoot: string, targetRoot: string): void {
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const target = `${targetRoot}/${entry.name}`;
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) assets.set(target, readBytes(source));
  }
}

function resolveOutputRoot(args: readonly string[]): string {
  const index = args.indexOf("--out-dir");
  if (index === -1) return defaultOutputRoot;
  const value = args[index + 1];
  if (!value) throw new Error("--out-dir requires a path");
  return path.resolve(value);
}

function readBytes(file: string): Uint8Array {
  return fs.readFileSync(file);
}

function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function sha256(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
