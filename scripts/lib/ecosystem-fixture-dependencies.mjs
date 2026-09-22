import fs from "node:fs";
import path from "node:path";

export function readProjectDependencyNames(projectDir) {
  const manifestPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(manifestPath)) return [];
  return collectProjectDependencyNames(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
}

export function collectProjectDependencyNames(manifest) {
  // Vite loads config-time tooling from devDependencies before dev/build starts.
  return uniqueNames([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {})
  ]).filter((name) => name !== "vite");
}

function uniqueNames(names) {
  return [...new Set(names.filter((name) => typeof name === "string" && name.length > 0))].sort();
}
