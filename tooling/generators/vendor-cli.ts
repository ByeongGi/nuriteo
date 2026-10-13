import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let manifestDir = path.resolve("vendor/manifests");
let outDir = path.resolve("vendor/cli");

function readManifest(name) {
  return JSON.parse(fs.readFileSync(path.join(manifestDir, `${name}.json`), "utf8"));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function versionEntry(manifest) {
  return `#!/usr/bin/env node
module.exports = ${JSON.stringify(manifest.version)};
if (require.main === module) console.log(${JSON.stringify(manifest.version)});
`;
}

function installedPath(manifest) {
  return path.join(outDir, manifest.name, manifest.version);
}

function writeInstalled(dir, installed) {
  fs.writeFileSync(path.join(dir, "installed.json"), `${JSON.stringify(installed, null, 2)}\n`);
}

function writeFixtureCli(manifest) {
  const dir = path.join(outDir, manifest.name, manifest.version);
  fs.mkdirSync(dir, { recursive: true });
  const entryPath = path.join(dir, manifest.entry.replace(/^\/package\//, ""));
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  const contents = versionEntry(manifest);
  fs.writeFileSync(entryPath, contents);
  fs.chmodSync(entryPath, 0o755);
  const hash = crypto.createHash("sha256").update(contents).digest("hex");
  const entryRelative = path.relative(process.cwd(), entryPath);
  const installed = {
    name: manifest.name,
    version: manifest.version,
    source: manifest.source,
    integrity: manifest.integrity,
    license: manifest.license,
    entry: entryRelative,
    entryRelative,
    entrySha256: hash,
    resolutionPolicy: manifest.resolutionPolicy,
    mode: "version-entry-fixture"
  };
  writeInstalled(dir, installed);
  return installed;
}

function tarballName(manifest) {
  return `${manifest.name}-${manifest.version}.tgz`;
}

function extractTarball(tarball, extractRoot) {
  fs.mkdirSync(extractRoot, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tarball, "-C", extractRoot], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar extraction failed for ${tarball}: ${result.stderr || result.stdout}`);
  }
  const packageRoot = path.join(extractRoot, "package");
  if (!fs.existsSync(packageRoot)) throw new Error(`tarball did not contain package/: ${tarball}`);
  return packageRoot;
}

function writeRealCli(manifest, tarballDir) {
  const tarball = path.join(tarballDir, tarballName(manifest));
  if (!fs.existsSync(tarball)) throw new Error(`missing CLI tarball: ${tarball}`);

  const dir = installedPath(manifest);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${manifest.name}-cli-`));
  try {
    const packageRoot = extractTarball(tarball, temp);
    const targetPackageRoot = path.join(dir, "package");
    fs.cpSync(packageRoot, targetPackageRoot, { recursive: true });

    const entryPath = path.join(dir, manifest.entry.replace(/^\//, ""));
    if (!fs.existsSync(entryPath)) throw new Error(`entry not found after install: ${entryPath}`);
    fs.chmodSync(entryPath, 0o755);

    const entryRelative = path.relative(process.cwd(), entryPath);
    const installed = {
      name: manifest.name,
      version: manifest.version,
      source: manifest.source,
      integrity: manifest.integrity,
      license: manifest.license,
      tarball: tarball,
      tarballRelative: path.relative(process.cwd(), tarball),
      tarballSha256: sha256File(tarball),
      entry: entryRelative,
      entryRelative,
      entrySha256: sha256File(entryPath),
      resolutionPolicy: manifest.resolutionPolicy,
      mode: "real-tarball"
    };
    writeInstalled(dir, installed);
    return installed;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = [...argv];
  let mode = "real-tarball";
  let tarballDir = process.env.CLI_TARBALL_DIR || "/private/tmp";
  const names = [];

  while (args.length) {
    const arg = args.shift();
    if (arg === "--fixture") {
      mode = "version-entry-fixture";
    } else if (arg === "--from-tarballs") {
      tarballDir = path.resolve(args.shift() ?? "");
      if (!tarballDir) throw new Error("--from-tarballs requires a directory");
    } else if (arg === "--out-dir") {
      outDir = path.resolve(args.shift() ?? "");
      if (!outDir) throw new Error("--out-dir requires a directory");
    } else if (arg === "--manifest-dir") {
      manifestDir = path.resolve(args.shift() ?? "");
      if (!manifestDir) throw new Error("--manifest-dir requires a directory");
    } else {
      names.push(arg);
    }
  }

  return { mode, tarballDir, names: names.length ? names : ["npm", "pnpm"] };
}

const { mode, tarballDir, names } = parseArgs(process.argv.slice(2));
const selected = names.length ? names : ["npm", "pnpm"];
const installed = selected.map((name) => {
  const manifest = readManifest(name);
  return mode === "version-entry-fixture" ? writeFixtureCli(manifest) : writeRealCli(manifest, tarballDir);
});
console.log(JSON.stringify({ installed }, null, 2));
