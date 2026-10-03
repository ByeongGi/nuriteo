import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiClientRoot = path.resolve(webRoot, "../../packages/api-client/src");
const clientChunksRoot = path.join(webRoot, ".next/static/chunks");
const browserClient = read("src/lib/api/browser-client.ts");
const serverClient = read("src/lib/api/server-client.ts");
const serverPolicy = read("src/lib/api/server-policy.ts");

assert.match(browserClient, /^"use client";/u);
const browserDependencySource = [
  browserClient,
  ...findFiles(apiClientRoot, ".ts").map(readAbsolute)
].join("\n");
assert.doesNotMatch(
  browserDependencySource,
  /process\.env|NURITEO_INTERNAL_API_URL|next\/headers|server-only/u
);
assert.match(serverClient, /import "server-only"/u);
assert.match(serverPolicy, /import "server-only"/u);
assert.match(serverClient, /process\.env\[INTERNAL_API_URL_ENV\]/u);

assert.ok(fs.existsSync(clientChunksRoot), "Run the production build before this check.");
const clientBundle = findFiles(clientChunksRoot, ".js").map(readAbsolute).join("\n");
assert.doesNotMatch(
  clientBundle,
  /NURITEO_INTERNAL_API_URL|createServerApiClient|next\/headers/u,
  "server-only API configuration leaked into a client chunk"
);

console.log("web bundle boundary ok");

function findFiles(directory: string, extension: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findFiles(absolutePath, extension);
    }
    return entry.name.endsWith(extension) ? [absolutePath] : [];
  });
}

function read(relativePath: string): string {
  return readAbsolute(path.join(webRoot, relativePath));
}

function readAbsolute(absolutePath: string): string {
  return fs.readFileSync(absolutePath, "utf8");
}
