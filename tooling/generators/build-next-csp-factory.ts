import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const nextManifestPath = require.resolve("next/package.json");
const nextManifest = JSON.parse(fs.readFileSync(nextManifestPath, "utf8")) as { version: string };
assert.equal(nextManifest.version, "15.1.9", "The Next CSP factory is pinned to Next.js 15.1.9");

const entry = path.join(path.dirname(nextManifestPath), "dist/bin/next");
const source = fs.readFileSync(entry, "utf8");
const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
const cspSafeSource = source
  .replace(/^#![^\n]*\n/, (line) => `//${line.slice(2)}`)
  .replace(/\bimport\s*\(/g, "__dynamicImport(");
assert.notEqual(cspSafeSource, source, "Expected to transform the Next CLI entry");

const output = `// Generated from the integrity-pinned Next.js ${nextManifest.version} CLI entry. Do not edit by hand.\n` +
  `export const sourceSha256 = ${JSON.stringify(sourceSha256)};\n` +
  `export function evaluateNextCjs(context, globals) {\n` +
  `const { module, require, exports, filename: __filename, dirname: __dirname } = context;\n` +
  `const process = globals.process;\nconst global = globals.global;\nconst globalThis = globals.globalThis;\n` +
  `const console = globals.console;\nconst Buffer = globals.Buffer;\nconst __dynamicImport = globals.__dynamicImport;\n` +
  `${cspSafeSource}\n}\n`;

const target = path.join(root, `apps/preview-service/public/vendor/next-cli-${nextManifest.version}.mjs`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, output);
console.log(`${path.relative(root, target)} sourceSha256=${sourceSha256} factorySha256=${crypto.createHash("sha256").update(output).digest("hex")}`);
