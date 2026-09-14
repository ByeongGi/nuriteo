import { join } from "../builtins/path.ts";
import { runInstallTransaction, type InstallTransactionOptions, type InstallTransactionResult } from "./install-transaction.ts";
import type { PnpmWorkspaceWriter } from "./pnpm-store.ts";

export interface NpmWorkspaceReader {
  readText(path: string): string;
}

export interface NpmInstallPlanOptions {
  cwd: string;
  reader: NpmWorkspaceReader;
  linkStrategy?: "symlink" | "copy-fallback";
}

export interface NpmInstallLink {
  name: string;
  targetPath: string;
  linkPath: string;
  strategy: "symlink" | "copy-fallback";
  binLinks: Array<{
    name: string;
    targetPath: string;
    linkPath: string;
  }>;
}

export interface NpmInstallPlan {
  packageManager: "npm";
  lockfileVersion: number;
  rootDependencies: string[];
  links: NpmInstallLink[];
  frozenLockfile: {
    path: string;
    valid: boolean;
    missingLinks: string[];
  };
}

export interface NpmInstallApplyResult {
  links: NpmInstallLink[];
  binLinks: Array<NpmInstallLink["binLinks"][number] & { strategy: NpmInstallLink["strategy"] }>;
  transaction: InstallTransactionResult;
}

export interface NpmInstallApplyOptions extends InstallTransactionOptions {}

export function createNpmInstallPlan(options: NpmInstallPlanOptions): NpmInstallPlan {
  const cwd = trimSlash(options.cwd);
  const rootManifest = readJson<PackageJson>(options.reader, join(cwd, "package.json"));
  const lockfilePath = join(cwd, "package-lock.json");
  const lockfile = readJson<NpmLockfile>(options.reader, lockfilePath);
  const dependencies = Object.entries(rootManifest.dependencies || {})
    .filter(([, specifier]) => specifier.startsWith("file:"));
  const links = dependencies.map(([name, specifier]) => {
    const targetRelative = specifier.slice("file:".length);
    const lockEntry = lockfile.packages[`node_modules/${name}`];
    if (!lockEntry?.link || lockEntry.resolved !== targetRelative) {
      return null;
    }
    const targetPath = join(cwd, targetRelative);
    const packageManifest = readJson<PackageJson>(options.reader, join(targetPath, "package.json"));
    return createNpmInstallLink(cwd, name, targetPath, packageManifest.bin, options.linkStrategy || "symlink");
  });
  const missingLinks = dependencies
    .filter(([, specifier], index) => !links[index] || !lockfileHasPackage(lockfile, specifier.slice("file:".length)))
    .map(([name]) => name);

  return {
    packageManager: "npm",
    lockfileVersion: lockfile.lockfileVersion,
    rootDependencies: dependencies.map(([name]) => name),
    links: links.filter((link): link is NpmInstallLink => Boolean(link)),
    frozenLockfile: {
      path: lockfilePath,
      valid: missingLinks.length === 0,
      missingLinks
    }
  };
}

export function applyNpmInstallPlan(plan: NpmInstallPlan, writer: PnpmWorkspaceWriter, options: NpmInstallApplyOptions = {}): NpmInstallApplyResult {
  if (!plan.frozenLockfile.valid) {
    throw new Error(`Cannot apply npm install plan with invalid frozen lockfile: ${plan.frozenLockfile.missingLinks.join(", ")}`);
  }
  const operations: Array<() => void> = [() => writer.mkdir(dirname(plan.links[0]?.linkPath || "/node_modules"))];
  const binLinks: NpmInstallApplyResult["binLinks"] = [];
  for (const link of plan.links) {
    operations.push(() => applyLink(writer, link.targetPath, link.linkPath, link.strategy));
    for (const bin of link.binLinks) {
      operations.push(() => applyLink(writer, bin.targetPath, bin.linkPath, link.strategy));
      binLinks.push({ ...bin, strategy: link.strategy });
    }
  }
  const transaction = runInstallTransaction(operations, options);
  return {
    links: plan.links,
    binLinks,
    transaction
  };
}

function createNpmInstallLink(cwd: string, name: string, targetPath: string, bin: PackageJson["bin"], strategy: NpmInstallLink["strategy"]): NpmInstallLink {
  return {
    name,
    targetPath,
    linkPath: join(cwd, "node_modules", name),
    strategy,
    binLinks: Object.entries(normalizeBin(bin)).map(([binName, target]) => ({
      name: binName,
      targetPath: join(targetPath, target),
      linkPath: join(cwd, "node_modules/.bin", binName)
    }))
  };
}

function applyLink(writer: PnpmWorkspaceWriter, targetPath: string, linkPath: string, strategy: NpmInstallLink["strategy"]): void {
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

function lockfileHasPackage(lockfile: NpmLockfile, targetRelative: string): boolean {
  return Boolean(lockfile.packages[targetRelative]);
}

function normalizeBin(bin: PackageJson["bin"]): Record<string, string> {
  if (!bin || typeof bin === "string") return {};
  return { ...bin };
}

function readJson<T>(reader: NpmWorkspaceReader, path: string): T {
  return JSON.parse(reader.readText(path)) as T;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
}

function trimSlash(path: string): string {
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
}

interface NpmLockfile {
  lockfileVersion: number;
  packages: Record<string, {
    resolved?: string;
    link?: boolean;
  }>;
}
