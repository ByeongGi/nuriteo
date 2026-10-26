import { dirname, join } from "../builtins/path.ts";
import { integritySha512 } from "../network/crypto.ts";
import type { MemoryPackageManagerWorkspace } from "./workspace.ts";

export interface RegistryPackageInstallerOptions {
  fetch?: typeof globalThis.fetch;
  registryUrl?: string;
  workspace: MemoryPackageManagerWorkspace;
}

export interface RegistryInstallRequest {
  cwd: string;
  exclude?: readonly string[];
  packages?: readonly string[];
  save?: "dependencies" | "devDependencies" | false;
  signal?: AbortSignal;
}

export interface RegistryInstalledPackage {
  name: string;
  optional: boolean;
  path: string;
  version: string;
}

export interface RegistryInstallResult {
  installed: RegistryInstalledPackage[];
  reused: RegistryInstalledPackage[];
}

interface PackageManifest {
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  name?: string;
  version?: string;
}

interface RegistryMetadata {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, PackageManifest & {
    dist?: { integrity?: string; tarball?: string };
  }>;
}

interface PackageRequest {
  name: string;
  range: string;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const IGNORED_SPECIFIERS = /^(?:file:|link:|workspace:|git(?:\+|:)|https?:)/u;

export class RegistryPackageInstaller {
  readonly #fetch: typeof globalThis.fetch;
  readonly #registryUrl: string;
  readonly #workspace: MemoryPackageManagerWorkspace;
  readonly #metadata = new Map<string, RegistryMetadata>();

  constructor(options: RegistryPackageInstallerOptions) {
    if (!options.fetch && typeof globalThis.fetch !== "function") {
      throw new Error("Registry package installation requires fetch");
    }
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#registryUrl = (options.registryUrl ?? DEFAULT_REGISTRY).replace(/\/$/u, "");
    this.#workspace = options.workspace;
  }

  async install(request: RegistryInstallRequest): Promise<RegistryInstallResult> {
    const manifestPath = join(request.cwd, "package.json");
    const manifest = this.#readManifest(manifestPath);
    const excluded = new Set(request.exclude ?? []);
    const requested = (request.packages?.length
      ? request.packages.map(parsePackageRequest)
      : manifestRequests(manifest)).filter((item) => !excluded.has(item.name));

    if (request.packages?.length && request.save !== false) {
      const field = request.save ?? "dependencies";
      const values = { ...(manifest[field] ?? {}) };
      for (const item of requested) values[item.name] = item.range;
      manifest[field] = values;
      this.#workspace.writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    const installed: RegistryInstalledPackage[] = [];
    const reused: RegistryInstalledPackage[] = [];
    const resolving = new Set<string>();
    for (const item of requested) {
      if (IGNORED_SPECIFIERS.test(item.range)) continue;
      await this.#installPackage(request.cwd, item, request.signal, installed, reused, resolving, false, null);
    }
    return { installed, reused };
  }

  async #installPackage(
    cwd: string,
    request: PackageRequest,
    signal: AbortSignal | undefined,
    installed: RegistryInstalledPackage[],
    reused: RegistryInstalledPackage[],
    resolving: Set<string>,
    optional: boolean,
    parentPackageRoot: string | null
  ): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const rootTarget = join(cwd, "node_modules", request.name);
    const rootPackage = this.#readInstalledPackage(rootTarget);
    if (rootPackage && isReusable(rootPackage, request.range)) {
      pushUnique(reused, rootPackage);
      return;
    }
    const target = parentPackageRoot && rootPackage
      ? join(parentPackageRoot, "node_modules", request.name)
      : rootTarget;
    const existing = target === rootTarget ? rootPackage : this.#readInstalledPackage(target);
    if (existing && isReusable(existing, request.range)) {
      pushUnique(reused, existing);
      return;
    }

    const resolutionKey = `${target}:${request.name}@${request.range}`;
    if (resolving.has(resolutionKey)) return;
    resolving.add(resolutionKey);
    try {
      const metadata = await this.#packageMetadata(request.name, signal);
      const version = resolveVersion(metadata, request.range);
      const manifest = metadata.versions?.[version];
      const tarball = manifest?.dist?.tarball;
      if (!manifest || !tarball) throw installError("ENOVERSION", `No registry tarball for ${request.name}@${request.range}`);

      const response = await this.#fetch(tarball, signal ? { signal } : undefined);
      if (!response.ok) throw installError("EFETCH", `Unable to download ${request.name}@${version}: HTTP ${response.status}`);
      const archive = new Uint8Array(await response.arrayBuffer());
      if (manifest.dist?.integrity && integritySha512(archive) !== manifest.dist.integrity) {
        throw installError("EINTEGRITY", `Integrity mismatch for ${request.name}@${version}`);
      }

      this.#workspace.remove(target);
      await this.#extractPackage(target, archive);
      const installedManifest = this.#readManifest(join(target, "package.json"));
      const installedPackage = {
        name: installedManifest.name ?? request.name,
        optional,
        path: target,
        version: installedManifest.version ?? version
      };
      pushUnique(installed, installedPackage);
      this.#linkBins(dirname(target), target, installedManifest);

      for (const dependency of manifestRequests(installedManifest, false)) {
        await this.#installPackage(cwd, dependency, signal, installed, reused, resolving, false, target);
      }
      for (const dependency of objectRequests(installedManifest.optionalDependencies)) {
        try {
          await this.#installPackage(cwd, dependency, signal, installed, reused, resolving, true, target);
        } catch {
          // npm-compatible best effort: an optional dependency must not fail the install.
        }
      }
    } catch (error) {
      if (!optional) throw error;
    } finally {
      resolving.delete(resolutionKey);
    }
  }

  async #packageMetadata(name: string, signal?: AbortSignal): Promise<RegistryMetadata> {
    const cached = this.#metadata.get(name);
    if (cached) return cached;
    const encoded = name.startsWith("@") ? name.replace("/", "%2f") : encodeURIComponent(name);
    const response = await this.#fetch(`${this.#registryUrl}/${encoded}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      ...(signal ? { signal } : {})
    });
    if (!response.ok) throw installError("EFETCH", `Unable to resolve ${name}: HTTP ${response.status}`);
    const metadata = await response.json() as RegistryMetadata;
    this.#metadata.set(name, metadata);
    return metadata;
  }

  async #extractPackage(target: string, archive: Uint8Array): Promise<void> {
    for (const entry of extractTarEntries(await decompressArchive(archive))) {
      const relative = stripPackagePrefix(entry.path);
      if (!relative) continue;
      this.#workspace.writeBytes(join(target, relative), entry.body);
    }
    if (!this.#workspace.exists(join(target, "package.json"))) {
      this.#workspace.remove(target);
      throw installError("EBADARCHIVE", `Package archive is missing package.json`);
    }
  }

  #linkBins(nodeModulesRoot: string, packageRoot: string, manifest: PackageManifest): void {
    if (!manifest.bin) return;
    const bins = typeof manifest.bin === "string"
      ? { [unscopedName(manifest.name ?? "package")]: manifest.bin }
      : manifest.bin;
    for (const [name, path] of Object.entries(bins)) {
      if (!path || path.startsWith("/") || path.split("/").includes("..")) continue;
      this.#workspace.symlink(join(packageRoot, path), join(nodeModulesRoot, ".bin", name));
    }
  }

  #readInstalledPackage(root: string): RegistryInstalledPackage | null {
    try {
      const manifest = this.#readManifest(join(root, "package.json"));
      if (!manifest.name || !manifest.version) return null;
      return { name: manifest.name, optional: false, path: root, version: manifest.version };
    } catch {
      return null;
    }
  }

  #readManifest(path: string): PackageManifest {
    try {
      return JSON.parse(this.#workspace.readText(path)) as PackageManifest;
    } catch (error) {
      throw installError("EBADMANIFEST", `Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function createRegistryPackageInstaller(options: RegistryPackageInstallerOptions): RegistryPackageInstaller {
  return new RegistryPackageInstaller(options);
}

function manifestRequests(manifest: PackageManifest, includeDev = true): PackageRequest[] {
  return mergeRequests(
    objectRequests(manifest.dependencies),
    includeDev ? objectRequests(manifest.devDependencies) : []
  );
}

function objectRequests(value?: Record<string, string>): PackageRequest[] {
  return Object.entries(value ?? {}).map(([name, range]) => ({ name, range }));
}

function mergeRequests(...groups: PackageRequest[][]): PackageRequest[] {
  const merged = new Map<string, PackageRequest>();
  for (const item of groups.flat()) merged.set(item.name, item);
  return [...merged.values()];
}

export function parsePackageRequest(specifier: string): PackageRequest {
  const value = specifier.trim();
  if (!value || value.startsWith("-")) throw installError("EBADSPEC", `Invalid package specifier: ${specifier}`);
  if (value.startsWith("@")) {
    const separator = value.indexOf("@", 1);
    return separator > value.indexOf("/")
      ? { name: value.slice(0, separator), range: value.slice(separator + 1) || "latest" }
      : { name: value, range: "latest" };
  }
  const separator = value.lastIndexOf("@");
  return separator > 0
    ? { name: value.slice(0, separator), range: value.slice(separator + 1) || "latest" }
    : { name: value, range: "latest" };
}

function resolveVersion(metadata: RegistryMetadata, range: string): string {
  const tag = metadata["dist-tags"]?.[range];
  if (tag && metadata.versions?.[tag]) return tag;
  const versions = Object.keys(metadata.versions ?? {}).sort(compareVersions).reverse();
  const version = versions.find((candidate) => satisfies(candidate, range));
  if (!version) throw installError("ENOVERSION", `No version satisfies ${range}`);
  return version;
}

function satisfies(version: string, range: string): boolean {
  const normalized = range.trim();
  if (!normalized || normalized === "*" || normalized === "latest") return true;
  if (normalized.includes("||")) return normalized.split("||").some((part) => satisfies(version, part));
  if (normalized.includes(" ")) return normalized.split(/\s+/u).filter(Boolean).every((part) => satisfies(version, part));
  const actual = parseVersion(version);
  if (!actual) return version === normalized;
  const operator = normalized.match(/^(\^|~|>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?/u);
  if (!operator) return version === normalized;
  const [, prefix = "", majorValue, minorValue, patchValue] = operator;
  const expected = [Number(majorValue), wildcardNumber(minorValue), wildcardNumber(patchValue)] as const;
  if (prefix === "^") {
    const upper = expected[0] > 0 ? [expected[0] + 1, 0, 0] : expected[1] > 0 ? [0, expected[1] + 1, 0] : [0, 0, expected[2] + 1];
    return compareTuple(actual, expected) >= 0 && compareTuple(actual, upper) < 0;
  }
  if (prefix === "~") {
    return compareTuple(actual, expected) >= 0 && compareTuple(actual, [expected[0], expected[1] + 1, 0]) < 0;
  }
  const compared = compareTuple(actual, expected);
  if (prefix === ">=") return compared >= 0;
  if (prefix === "<=") return compared <= 0;
  if (prefix === ">") return compared > 0;
  if (prefix === "<") return compared < 0;
  if (minorValue === undefined || isWildcard(minorValue)) return actual[0] === expected[0];
  if (patchValue === undefined || isWildcard(patchValue)) return actual[0] === expected[0] && actual[1] === expected[1];
  return compared === 0;
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-|$)/u);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return left.localeCompare(right);
  return compareTuple(leftVersion, rightVersion);
}

function compareTuple(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function wildcardNumber(value: string | undefined): number {
  return value === undefined || isWildcard(value) ? 0 : Number(value);
}

function isWildcard(value: string): boolean {
  return value === "x" || value === "X" || value === "*";
}

function stripPackagePrefix(path: string): string | null {
  const normalized = path.replace(/^\.\//u, "");
  const relative = normalized.startsWith("package/") ? normalized.slice("package/".length) : normalized;
  if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) return null;
  return relative;
}

function unscopedName(name: string): string {
  return name.split("/").at(-1) ?? name;
}

function pushUnique(values: RegistryInstalledPackage[], value: RegistryInstalledPackage): void {
  if (!values.some((entry) => entry.path === value.path && entry.version === value.version)) values.push(value);
}

function isReusable(installed: RegistryInstalledPackage, range: string): boolean {
  return installed.version !== "product-fixture" && satisfies(installed.version, range);
}

function installError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

async function decompressArchive(input: Uint8Array): Promise<Uint8Array> {
  if (input[0] !== 0x1f || input[1] !== 0x8b) return input;
  if (typeof DecompressionStream !== "function") {
    throw installError("EDECOMPRESS", "This browser cannot decompress npm package archives");
  }
  const bytes = Uint8Array.from(input);
  const stream = new Blob([bytes.buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function extractTarEntries(input: Uint8Array): Array<{ path: string; body: Uint8Array }> {
  const entries: Array<{ path: string; body: Uint8Array }> = [];
  for (let offset = 0; offset + 512 <= input.byteLength;) {
    const header = input.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const path = readTarString(header, 0, 100);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > input.byteLength) throw installError("EBADARCHIVE", `Truncated package archive entry: ${path}`);
    if (type === "0" || type === "\0") entries.push({ path, body: input.slice(bodyStart, bodyEnd) });
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(bytes: Uint8Array, offset: number, length: number): string {
  let output = "";
  for (let index = offset; index < offset + length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0) break;
    output += String.fromCharCode(byte);
  }
  return output;
}
