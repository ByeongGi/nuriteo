import { join, relative } from "../builtins/path.ts";
import { runInstallTransaction, type InstallTransactionOptions, type InstallTransactionResult } from "./install-transaction.ts";
import type { PackageManagerWorkspaceReader, PackageManagerWorkspaceWriter } from "./workspace.ts";

export interface PnpmWorkspaceReader extends PackageManagerWorkspaceReader {}

export interface PnpmWorkspaceWriter extends PackageManagerWorkspaceWriter {}

export interface PnpmStorePlanOptions {
  cwd: string;
  reader: PnpmWorkspaceReader;
  storeDir?: string;
  virtualStoreDir?: string;
  linkStrategy?: PnpmWorkspaceLink["strategy"];
}

export interface PnpmWorkspacePackage {
  name: string;
  version: string;
  path: string;
  bin: Record<string, string>;
}

export interface PnpmWorkspaceLink {
  name: string;
  dependencyPath: string;
  targetPath: string;
  linkPath: string;
  strategy: "symlink" | "copy-fallback";
  binLinks: Array<{
    name: string;
    targetPath: string;
    linkPath: string;
  }>;
}

export interface PnpmStorePlan {
  packageManager: string;
  storeDir: string;
  virtualStoreDir: string;
  workspacePackages: PnpmWorkspacePackage[];
  rootLinks: PnpmWorkspaceLink[];
  frozenLockfile: {
    path: string;
    valid: boolean;
    missingLinks: string[];
  };
}

export interface PnpmStoreApplyResult {
  directoriesCreated: string[];
  packageLinks: PnpmWorkspaceLink[];
  binLinks: Array<{
    name: string;
    targetPath: string;
    linkPath: string;
    strategy: PnpmWorkspaceLink["strategy"];
  }>;
  transaction: InstallTransactionResult;
}

export interface PnpmStoreApplyOptions extends InstallTransactionOptions {}

export function createPnpmStorePlan(options: PnpmStorePlanOptions): PnpmStorePlan {
  const cwd = trimSlash(options.cwd);
  const rootManifest = readJson<PackageJson>(options.reader, join(cwd, "package.json"));
  const workspacePatterns = readWorkspacePatterns(options.reader.readText(join(cwd, "pnpm-workspace.yaml")));
  const workspacePackages = discoverWorkspacePackages(options.reader, cwd, workspacePatterns);
  const packageByName = new Map(workspacePackages.map((pkg) => [pkg.name, pkg]));
  const rootDependencies = Object.entries(rootManifest.dependencies || {})
    .filter(([, specifier]) => specifier === "workspace:*");
  const rootLinks = rootDependencies.map(([name]) => {
    const dependency = packageByName.get(name);
    if (!dependency) throw new Error(`Missing pnpm workspace package: ${name}`);
    return createWorkspaceLink(cwd, dependency, options.linkStrategy || "symlink");
  });
  const lockfilePath = join(cwd, "pnpm-lock.yaml");
  const lockfile = options.reader.readText(lockfilePath);
  const missingLinks = rootLinks
    .map((link) => `version: link:${relative(cwd, link.targetPath)}`)
    .filter((expected) => !lockfile.includes(expected));

  return {
    packageManager: rootManifest.packageManager || "pnpm",
    storeDir: options.storeDir || join(cwd, ".pnpm-store"),
    virtualStoreDir: options.virtualStoreDir || join(cwd, "node_modules/.pnpm"),
    workspacePackages,
    rootLinks,
    frozenLockfile: {
      path: lockfilePath,
      valid: missingLinks.length === 0,
      missingLinks
    }
  };
}

export function applyPnpmStorePlan(plan: PnpmStorePlan, writer: PnpmWorkspaceWriter, options: PnpmStoreApplyOptions = {}): PnpmStoreApplyResult {
  if (!plan.frozenLockfile.valid) {
    throw new Error(`Cannot apply pnpm store plan with invalid frozen lockfile: ${plan.frozenLockfile.missingLinks.join(", ")}`);
  }
  const directoriesCreated = [plan.storeDir, plan.virtualStoreDir, join(dirname(plan.virtualStoreDir), ".bin")];
  const binLinks: PnpmStoreApplyResult["binLinks"] = [];
  const operations: Array<() => void> = directoriesCreated.map((directory) => () => writer.mkdir(directory));
  for (const link of plan.rootLinks) {
    operations.push(() => applyLink(writer, link.targetPath, link.linkPath, link.strategy));
    for (const bin of link.binLinks) {
      operations.push(() => applyLink(writer, bin.targetPath, bin.linkPath, link.strategy));
      binLinks.push({ ...bin, strategy: link.strategy });
    }
  }

  operations.push(() => writer.writeText(join(plan.virtualStoreDir, "browser-native-plan.json"), JSON.stringify({
    packageManager: plan.packageManager,
    rootLinks: plan.rootLinks.map((link) => ({
      name: link.name,
      dependencyPath: link.dependencyPath,
      linkPath: link.linkPath,
      strategy: link.strategy
    }))
  }, null, 2)));
  const transaction = runInstallTransaction(operations, options);

  return {
    directoriesCreated,
    packageLinks: plan.rootLinks,
    binLinks,
    transaction
  };
}

function createWorkspaceLink(cwd: string, dependency: PnpmWorkspacePackage, strategy: PnpmWorkspaceLink["strategy"]): PnpmWorkspaceLink {
  const linkPath = join(cwd, "node_modules", dependency.name);
  return {
    name: dependency.name,
    dependencyPath: dependency.path,
    targetPath: dependency.path,
    linkPath,
    strategy,
    binLinks: Object.entries(dependency.bin).map(([name, target]) => ({
      name,
      targetPath: join(dependency.path, target),
      linkPath: join(cwd, "node_modules/.bin", name)
    }))
  };
}

function applyLink(writer: PnpmWorkspaceWriter, targetPath: string, linkPath: string, strategy: PnpmWorkspaceLink["strategy"]): void {
  writer.mkdir(dirname(linkPath));
  if (strategy === "symlink" && writer.symlink) {
    writer.symlink(targetPath, linkPath);
    return;
  }
  if (strategy === "symlink") {
    writer.writeText(`${linkPath}.link`, targetPath);
    return;
  }
  if (targetPath.endsWith(".js") || targetPath.includes("/bin/")) writer.copyFile(targetPath, linkPath);
  else writer.copyDirectory(targetPath, linkPath);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
}

function discoverWorkspacePackages(reader: PnpmWorkspaceReader, cwd: string, patterns: string[]): PnpmWorkspacePackage[] {
  const packages: PnpmWorkspacePackage[] = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) continue;
    const base = join(cwd, pattern.slice(0, -2));
    for (const entry of reader.listDir(base)) {
      const packagePath = join(base, entry);
      const manifest = readJson<PackageJson>(reader, join(packagePath, "package.json"));
      if (!manifest.name) continue;
      packages.push({
        name: manifest.name,
        version: manifest.version || "0.0.0",
        path: packagePath,
        bin: normalizeBin(manifest.bin)
      });
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function readWorkspacePatterns(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim().replace(/^["']|["']$/g, ""));
}

function normalizeBin(bin: PackageJson["bin"]): Record<string, string> {
  if (!bin) return {};
  if (typeof bin === "string") return {};
  return { ...bin };
}

function readJson<T>(reader: PnpmWorkspaceReader, path: string): T {
  return JSON.parse(reader.readText(path)) as T;
}

function trimSlash(path: string): string {
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}

interface PackageJson {
  name?: string;
  version?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
}
