import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const productionRoots = ["apps/web", "packages/workspace-runtime", "packages/api-client", "crates/nuriteo-server"];
const legacyRoots = ["apps/preview-service", "packages/service-backend"];
const forbiddenPackages = ["@nuriteo/preview-service", "@nuriteo/preview-service-app", "@nuriteo/service-backend"];
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".rs",
  ".css",
  ".scss",
  ".sass",
  ".less",
]);
const ignoredDirectories = new Set([".git", ".next", "dist", "node_modules", "target"]);

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replace(/^file:\/\//, "").split(/[?#]/, 1)[0];
}

function isWithin(relativePath: string, root: string): boolean {
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

function forbiddenTarget(specifier: string, importer: string): string | undefined {
  const normalized = normalize(specifier);
  const forbiddenPackage = forbiddenPackages.find(
    (name) => normalized === name || normalized.startsWith(`${name}/`),
  );
  if (forbiddenPackage) return forbiddenPackage;

  const literalRoot = legacyRoots.find(
    (root) => normalized === root || normalized.includes(`/${root}`) || normalized.startsWith(`${root}/`),
  );
  if (literalRoot) return literalRoot;

  if (normalized.startsWith(".") || path.isAbsolute(normalized)) {
    const resolved = path.resolve(path.dirname(importer), normalized);
    const relative = normalize(path.relative(repositoryRoot, resolved));
    return legacyRoots.find((root) => isWithin(relative, root));
  }

  return undefined;
}

function extractSourceSpecifiers(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s*)?["']([^"']+)["']/g,
    /\b(?:import|require(?:\.resolve)?)\s*\(\s*["']([^"']+)["']/g,
    /\bimport\.meta\.resolve\s*\(\s*["']([^"']+)["']/g,
    /\bnew\s+URL\s*\(\s*["']([^"']+)["']/g,
    /\binclude(?:_str|_bytes)?!\s*\(\s*["']([^"']+)["']\s*\)/g,
    /#\s*\[\s*path\s*=\s*["']([^"']+)["']\s*\]/g,
    /@import\s+(?:url\(\s*)?["']([^"']+)["']/g,
  ];

  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function inspectPathConfiguration(file: string): string[] {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  const specifiers: string[] = [];
  const collectStrings = (value: unknown): void => {
    if (typeof value === "string") specifiers.push(value);
    else if (Array.isArray(value)) value.forEach(collectStrings);
    else if (value && typeof value === "object") Object.values(value).forEach(collectStrings);
  };
  collectStrings(document.compilerOptions?.paths ?? {});

  return specifiers.flatMap((specifier) => {
    const target = forbiddenTarget(specifier, file);
    return target
      ? [`${normalize(path.relative(repositoryRoot, file))}: path alias ${specifier} -> ${target}`]
      : [];
  });
}

function inspectPackageManifest(file: string): string[] {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const violations: string[] = [];

  for (const section of dependencySections) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      const target = forbiddenTarget(name, file) ?? forbiddenTarget(String(specifier), file);
      if (target) violations.push(`${normalize(path.relative(repositoryRoot, file))}: ${section}.${name} -> ${target}`);
    }
  }

  return violations;
}

function inspectCargoManifest(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  return [...source.matchAll(/\bpath\s*=\s*["']([^"']+)["']/g)].flatMap((match) => {
    const target = forbiddenTarget(match[1], file);
    return target ? [`${normalize(path.relative(repositoryRoot, file))}: path ${match[1]} -> ${target}`] : [];
  });
}

function inspectSource(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  return extractSourceSpecifiers(source).flatMap((specifier) => {
    const target = forbiddenTarget(specifier, file);
    return target
      ? [`${normalize(path.relative(repositoryRoot, file))}: import ${specifier} -> ${target}`]
      : [];
  });
}

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : walk(absolute);
    return entry.isFile() ? [absolute] : [];
  });
}

function inspectProductionRoot(relativeRoot: string): string[] {
  return walk(path.join(repositoryRoot, relativeRoot)).flatMap((file) => {
    if (path.basename(file) === "package.json") return inspectPackageManifest(file);
    if (path.basename(file) === "Cargo.toml") return inspectCargoManifest(file);
    if (/^(?:tsconfig(?:\..+)?|jsconfig)\.json$/.test(path.basename(file))) return inspectPathConfiguration(file);
    return sourceExtensions.has(path.extname(file)) ? inspectSource(file) : [];
  });
}

for (const legacyRoot of legacyRoots) {
  assert.equal(fs.existsSync(path.join(repositoryRoot, legacyRoot)), false, `${legacyRoot} must stay removed`);
}

const syntheticImporter = path.join(repositoryRoot, "apps/web/src/example.ts");
assert.equal(forbiddenTarget("@nuriteo/service-backend", syntheticImporter), "@nuriteo/service-backend");
assert.equal(
  forbiddenTarget("../../../packages/service-backend/src/index.ts", syntheticImporter),
  "packages/service-backend",
);
assert.equal(forbiddenTarget("../../preview-service/src/App.tsx", syntheticImporter), "apps/preview-service");
assert.equal(forbiddenTarget("@nuriteo/preview-service", syntheticImporter), "@nuriteo/preview-service");
assert.equal(forbiddenTarget("@nuriteo/workspace-runtime", syntheticImporter), undefined);
assert.equal(forbiddenTarget("@nuriteo/browser-host", syntheticImporter), undefined);
assert.deepEqual(
  extractSourceSpecifiers(`
    import backend from "@nuriteo/service-backend";
    const app = import("../../preview-service/src/App.tsx", { with: { type: "module" } });
    import { createPreviewWorkflowController } from "@nuriteo/workspace-runtime";
  `),
  ["@nuriteo/service-backend", "@nuriteo/workspace-runtime", "../../preview-service/src/App.tsx"],
);

const violations = productionRoots.flatMap(inspectProductionRoot);
assert.equal(
  violations.length,
  0,
  `new production code must not depend on reference-only implementations:\n${violations.join("\n")}`,
);

console.log("legacy production boundary check passed");
