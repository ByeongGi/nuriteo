import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const forbidden = [
  "apps/preview-service",
  "packages/service-backend",
  "@nuriteo/preview-service",
  "@nuriteo/service-backend",
  "examples/runtime-lab",
];
const scannedRoots = ["package.json", "tsconfig.json", "tsconfig.test.json", "tsconfig.tools.json", ".github/workflows", "tooling", "tests"];
const allowed = new Set([
  "tooling/checks/check-legacy-production-boundaries.ts",
  "tooling/checks/check-self-hosted-legacy-replacement.ts",
  "tooling/checks/check-stale-legacy-references.ts",
]);
const ignoredDirectories = new Set([".git", ".next", "dist", "node_modules", "target"]);

function relative(file: string): string {
  return path.relative(root, file).replaceAll("\\", "/");
}

function walk(entry: string): string[] {
  const absolute = path.join(root, entry);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((item) => {
    if (item.isDirectory() && ignoredDirectories.has(item.name)) return [];
    const child = path.join(absolute, item.name);
    return item.isDirectory() ? walk(relative(child)) : [child];
  });
}

const violations = scannedRoots.flatMap(walk).flatMap((file) => {
  const repoPath = relative(file);
  if (allowed.has(repoPath)) return [];
  const source = fs.readFileSync(file, "utf8");
  return forbidden.filter((token) => source.includes(token)).map((token) => `${repoPath}: ${token}`);
});

assert.deepEqual(violations, [], `stale legacy references remain in executable surfaces:\n${violations.join("\n")}`);
for (const removed of ["apps/preview-service", "packages/service-backend", "examples/runtime-lab"]) {
  assert.equal(fs.existsSync(path.join(root, removed)), false, `${removed} must stay outside the production graph`);
}
for (const required of ["apps/web", "packages/workspace-runtime", "tests/fixtures/runtime-lab"]) {
  assert.equal(fs.existsSync(path.join(root, required)), true, `${required} is missing`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
assert.equal(manifest.scripts["dev:web"], "pnpm --filter @nuriteo/web dev");
assert.equal(manifest.scripts["build:web"], "pnpm --filter @nuriteo/web build");
assert.equal(manifest.scripts["test:web"], "pnpm --filter @nuriteo/web test");
assert.equal(manifest.scripts["test:workspace-runtime"], "pnpm --filter @nuriteo/workspace-runtime test");
for (const removedScript of ["dev:lab", "dev:preview", "build:preview", "test:preview-service", "test:service-backend"]) {
  assert.equal(manifest.scripts[removedScript], undefined, `${removedScript} must stay removed`);
}

console.log(`legacy cleanup ok (${scannedRoots.length} executable surfaces, ${violations.length} stale references)`);
