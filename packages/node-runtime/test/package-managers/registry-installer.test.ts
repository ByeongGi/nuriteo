import assert from "node:assert/strict";

import { integritySha512 } from "../../src/network/crypto.ts";
import { createRegistryPackageInstaller, parsePackageRequest } from "../../src/package-managers/registry-installer.ts";
import { MemoryPackageManagerWorkspace } from "../../src/package-managers/workspace.ts";

const workspace = new MemoryPackageManagerWorkspace([{
  path: "/workspace/package.json",
  data: JSON.stringify({ name: "registry-test", dependencies: { "fixture-tool": "^2.0.0" } })
}]);

const depArchive = tar({
  "package/package.json": JSON.stringify({ name: "fixture-dep", version: "1.2.0", main: "index.js" }),
  "package/index.js": "module.exports = 'dependency';\n"
});
const toolArchive = tar({
  "package/package.json": JSON.stringify({
    name: "fixture-tool",
    version: "2.1.0",
    dependencies: { "fixture-dep": "^1.0.0" },
    bin: { "fixture-cli": "cli.js" }
  }),
  "package/cli.js": "#!/usr/bin/env node\nconsole.log('fixture-cli');\n",
  "package/index.js": "module.exports = require('fixture-dep');\n"
});

const calls: string[] = [];
const fetchMock: typeof fetch = async (input) => {
  const url = String(input);
  calls.push(url);
  if (url.endsWith("/fixture-tool")) return Response.json(metadata("fixture-tool", "2.1.0", "https://tar.test/fixture-tool.tgz", toolArchive));
  if (url.endsWith("/fixture-dep")) return Response.json(metadata("fixture-dep", "1.2.0", "https://tar.test/fixture-dep.tgz", depArchive));
  if (url === "https://tar.test/fixture-tool.tgz") return new Response(toolArchive);
  if (url === "https://tar.test/fixture-dep.tgz") return new Response(depArchive);
  return new Response("not found", { status: 404 });
};

const installer = createRegistryPackageInstaller({ fetch: fetchMock, workspace });
const first = await installer.install({ cwd: "/workspace" });
assert.deepEqual(first.installed.map(({ name, version }) => ({ name, version })), [
  { name: "fixture-tool", version: "2.1.0" },
  { name: "fixture-dep", version: "1.2.0" }
]);
assert.equal(workspace.readText("/workspace/node_modules/fixture-tool/index.js"), "module.exports = require('fixture-dep');\n");
assert.equal(workspace.readlink("/workspace/node_modules/.bin/fixture-cli"), "/workspace/node_modules/fixture-tool/cli.js");

const second = await installer.install({ cwd: "/workspace" });
assert.deepEqual(second.installed, []);
assert.deepEqual(second.reused.map(({ name, version }) => ({ name, version })), [{ name: "fixture-tool", version: "2.1.0" }]);
assert.equal(calls.filter((url) => url.includes("tar.test")).length, 2);

await installer.install({ cwd: "/workspace", packages: ["fixture-dep@~1.2.0"], save: "devDependencies" });
const manifest = JSON.parse(workspace.readText("/workspace/package.json"));
assert.equal(manifest.devDependencies["fixture-dep"], "~1.2.0");
assert.deepEqual(parsePackageRequest("@scope/tool@3.2.1"), { name: "@scope/tool", range: "3.2.1" });

const conflictWorkspace = new MemoryPackageManagerWorkspace([{
  path: "/conflict/package.json",
  data: JSON.stringify({ dependencies: { "uses-shared-one": "1.0.0", "uses-shared-two": "1.0.0" } })
}]);
const conflictArchives = new Map<string, Uint8Array>([
  ["uses-shared-one", packageTar("uses-shared-one", "1.0.0", { shared: "^1.0.0" })],
  ["uses-shared-two", packageTar("uses-shared-two", "1.0.0", { shared: "^2.0.0" })],
  ["shared-1.0.0", packageTar("shared", "1.0.0")],
  ["shared-2.0.0", packageTar("shared", "2.0.0")]
]);
const conflictFetch: typeof fetch = async (input) => {
  const url = String(input);
  const tarballMatch = url.match(/https:\/\/tar\.test\/(.+)\.tgz$/u);
  if (tarballMatch) return new Response(conflictArchives.get(tarballMatch[1]!) ?? new Uint8Array());
  const name = url.split("/").at(-1)!;
  if (name === "shared") {
    return Response.json({
      "dist-tags": { latest: "2.0.0" },
      versions: Object.fromEntries(["1.0.0", "2.0.0"].map((version) => {
        const body = conflictArchives.get(`shared-${version}`)!;
        return [version, { name, version, dist: { integrity: integritySha512(body), tarball: `https://tar.test/shared-${version}.tgz` } }];
      }))
    });
  }
  const body = conflictArchives.get(name)!;
  return Response.json(metadata(name, "1.0.0", `https://tar.test/${name}.tgz`, body));
};
await createRegistryPackageInstaller({ fetch: conflictFetch, workspace: conflictWorkspace }).install({ cwd: "/conflict" });
assert.equal(JSON.parse(conflictWorkspace.readText("/conflict/node_modules/shared/package.json")).version, "1.0.0");
assert.equal(JSON.parse(conflictWorkspace.readText("/conflict/node_modules/uses-shared-two/node_modules/shared/package.json")).version, "2.0.0");

console.log("node registry package installer test ok");

function metadata(name: string, version: string, tarball: string, archive: Uint8Array) {
  return {
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name,
        version,
        dist: { integrity: integritySha512(archive), tarball }
      }
    }
  };
}

function packageTar(name: string, version: string, dependencies?: Record<string, string>): Uint8Array {
  return tar({ "package/package.json": JSON.stringify({ name, version, ...(dependencies ? { dependencies } : {}) }) });
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
