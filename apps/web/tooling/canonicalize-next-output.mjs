import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve(process.argv[2] ?? ".next");
const clientManifestSuffix = "_client-reference-manifest.js";

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }

  return value;
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function canonicalJson(source) {
  return JSON.stringify(canonicalize(JSON.parse(source)));
}

function canonicalClientManifest(source, filePath) {
  const assignment = source.indexOf("]={");
  if (assignment === -1) {
    throw new Error(`unexpected client reference manifest format: ${filePath}`);
  }

  const jsonOffset = assignment + 2;
  return `${source.slice(0, jsonOffset)}${canonicalJson(source.slice(jsonOffset))}`;
}

let changed = 0;
for (const filePath of await collectFiles(outputDirectory)) {
  const isJson = filePath.endsWith(".json");
  const isClientManifest = filePath.endsWith(clientManifestSuffix);
  if (!isJson && !isClientManifest) continue;

  const source = await readFile(filePath, "utf8");
  const canonical = isJson
    ? canonicalJson(source)
    : canonicalClientManifest(source, filePath);
  if (canonical !== source) {
    await writeFile(filePath, canonical);
    changed += 1;
  }
}

console.log(`canonicalized Next.js output (${changed} files changed)`);
