import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve(
  process.argv[2] ?? process.env.NURITEO_NEXT_DIST_DIR ?? ".next"
);
const clientManifestSuffix = "_client-reference-manifest.js";
const buildRevision = process.env.NURITEO_BUILD_REVISION ?? "development";

function derivedHex(label) {
  return createHash("sha256").update(`nuriteo-next:${buildRevision}:${label}`).digest("hex");
}

function canonicalizeGeneratedKeys(value, filePath) {
  if (filePath.endsWith(`${path.sep}prerender-manifest.json`)) {
    value.preview = {
      previewModeEncryptionKey: derivedHex("preview-encryption"),
      previewModeId: derivedHex("preview-id").slice(0, 32),
      previewModeSigningKey: derivedHex("preview-signing")
    };
  }
  if (filePath.endsWith(`${path.sep}server-reference-manifest.json`)) {
    value.encryptionKey = Buffer.from(derivedHex("server-actions"), "hex").toString("base64");
  }
  return value;
}

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

function canonicalJson(source, filePath) {
  return JSON.stringify(canonicalize(canonicalizeGeneratedKeys(JSON.parse(source), filePath)));
}

function canonicalClientManifest(source, filePath) {
  const assignment = source.indexOf("]={");
  if (assignment === -1) {
    throw new Error(`unexpected client reference manifest format: ${filePath}`);
  }

  const jsonOffset = assignment + 2;
  return `${source.slice(0, jsonOffset)}${canonicalJson(source.slice(jsonOffset), filePath)}`;
}

let changed = 0;
for (const filePath of await collectFiles(outputDirectory)) {
  const isJson = filePath.endsWith(".json");
  const isClientManifest = filePath.endsWith(clientManifestSuffix);
  if (!isJson && !isClientManifest) continue;

  const source = await readFile(filePath, "utf8");
  const canonical = isJson
    ? canonicalJson(source, filePath)
    : canonicalClientManifest(source, filePath);
  if (canonical !== source) {
    await writeFile(filePath, canonical);
    changed += 1;
  }
}

const standaloneServerDirectory = path.join(
  outputDirectory,
  "standalone",
  "apps",
  "web",
  ".next",
  "server"
);
const vendorChunksDirectory = path.join(outputDirectory, "server", "vendor-chunks");
let copiedVendorChunks = false;

try {
  const [standaloneServer, vendorChunks] = await Promise.all([
    stat(standaloneServerDirectory),
    stat(vendorChunksDirectory)
  ]);
  if (standaloneServer.isDirectory() && vendorChunks.isDirectory()) {
    await mkdir(path.join(standaloneServerDirectory, "vendor-chunks"), { recursive: true });
    await cp(vendorChunksDirectory, path.join(standaloneServerDirectory, "vendor-chunks"), {
      force: true,
      recursive: true
    });
    copiedVendorChunks = true;
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

console.log(`canonicalized Next.js output (${changed} files changed; vendor chunks ${copiedVendorChunks ? "synced" : "not required"})`);
