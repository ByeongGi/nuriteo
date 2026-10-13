import { join } from "../builtins/path.ts";
import { runInstallTransaction, type InstallTransactionOptions, type InstallTransactionResult } from "./install-transaction.ts";
import type { PackageManagerWorkspaceReader, PackageManagerWorkspaceWriter } from "./workspace.ts";

export interface YarnInstallPlanOptions {
  cwd: string;
  reader: PackageManagerWorkspaceReader;
  linkStrategy?: YarnInstallLink["strategy"];
}

export interface YarnInstallLink {
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

export interface YarnInstallPlan {
  packageManager: "yarn";
  lockfileVersion: 1;
  rootDependencies: string[];
  links: YarnInstallLink[];
  frozenLockfile: {
    path: string;
    valid: boolean;
    missingLinks: string[];
  };
}

export interface YarnInstallApplyResult {
  links: YarnInstallLink[];
  binLinks: Array<YarnInstallLink["binLinks"][number] & { strategy: YarnInstallLink["strategy"] }>;
  transaction: InstallTransactionResult;
}

export interface YarnInstallApplyOptions extends InstallTransactionOptions {}

export function createYarnInstallPlan(options: YarnInstallPlanOptions): YarnInstallPlan {
  const cwd = trimSlash(options.cwd);
  const manifest = readJson<PackageJson>(options.reader, join(cwd, "package.json"));
  const lockfilePath = join(cwd, "yarn.lock");
  const lockfile = options.reader.readText(lockfilePath);
  const dependencies = Object.entries(manifest.dependencies || {})
    .filter(([, specifier]) => specifier.startsWith("file:"));
  const links = dependencies.map(([name, specifier]) => {
    const targetRelative = specifier.slice("file:".length);
    const targetPath = join(cwd, targetRelative);
    const dependencyManifest = readJson<PackageJson>(options.reader, join(targetPath, "package.json"));
    return createYarnInstallLink(
      cwd,
      name,
      targetPath,
      dependencyManifest.bin,
      options.linkStrategy || "symlink"
    );
  });
  const missingLinks = dependencies
    .filter(([name, specifier]) => !hasYarnLockEntry(lockfile, name, specifier))
    .map(([name]) => name);

  return {
    packageManager: "yarn",
    lockfileVersion: 1,
    rootDependencies: dependencies.map(([name]) => name),
    links,
    frozenLockfile: {
      path: lockfilePath,
      valid: missingLinks.length === 0,
      missingLinks
    }
  };
}

export function applyYarnInstallPlan(
  plan: YarnInstallPlan,
  writer: PackageManagerWorkspaceWriter,
  options: YarnInstallApplyOptions = {}
): YarnInstallApplyResult {
  if (!plan.frozenLockfile.valid) {
    throw new Error(`Cannot apply Yarn install plan with invalid frozen lockfile: ${plan.frozenLockfile.missingLinks.join(", ")}`);
  }
  const operations: Array<() => void> = [() => writer.mkdir(dirname(plan.links[0]?.linkPath || "/node_modules"))];
  const binLinks: YarnInstallApplyResult["binLinks"] = [];
  for (const link of plan.links) {
    operations.push(() => applyLink(writer, link.targetPath, link.linkPath, link.strategy));
    for (const bin of link.binLinks) {
      operations.push(() => applyLink(writer, bin.targetPath, bin.linkPath, link.strategy));
      binLinks.push({ ...bin, strategy: link.strategy });
    }
  }
  return {
    links: plan.links,
    binLinks,
    transaction: runInstallTransaction(operations, options)
  };
}

function createYarnInstallLink(
  cwd: string,
  name: string,
  targetPath: string,
  bin: PackageJson["bin"],
  strategy: YarnInstallLink["strategy"]
): YarnInstallLink {
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

function hasYarnLockEntry(lockfile: string, name: string, specifier: string): boolean {
  const selector = `${name}@${specifier}`;
  return lockfile.split("\n").some((line) => {
    const normalized = line.trim().replace(/^"|":$/g, "");
    return normalized === `${selector}:` || normalized === selector;
  });
}

function applyLink(
  writer: PackageManagerWorkspaceWriter,
  targetPath: string,
  linkPath: string,
  strategy: YarnInstallLink["strategy"]
): void {
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

function normalizeBin(bin: PackageJson["bin"]): Record<string, string> {
  if (!bin || typeof bin === "string") return {};
  return { ...bin };
}

function readJson<T>(reader: PackageManagerWorkspaceReader, path: string): T {
  return JSON.parse(reader.readText(path)) as T;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function trimSlash(path: string): string {
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
}
