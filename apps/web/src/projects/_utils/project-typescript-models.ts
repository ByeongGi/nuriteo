export const PROJECT_TYPESCRIPT_MODEL_LIMIT = 350;
export const DEPENDENCY_DECLARATION_LIMIT = 150;

const OPEN_FILE_RANK = 0;
const PROJECT_CONFIG_RANK = 1_000;
const PROJECT_DECLARATION_RANK = 1_500;
const PROJECT_SOURCE_RANK = 2_000;
const DECLARATION_INDEX_RANK = 0;
const DECLARATION_JSX_RUNTIME_RANK = 1;
const DECLARATION_TYPES_RANK = 2;
const DECLARATION_OTHER_RANK = 3;

interface WorkspacePathFile {
  readonly kind: "text" | "binary";
  readonly path: string;
}

interface SelectTypeScriptModelPathsInput {
  readonly files: readonly WorkspacePathFile[];
  readonly packageNames: ReadonlySet<string>;
  readonly priorityPaths: readonly string[];
}

const TYPESCRIPT_MODEL_PATH = /(?:^|\/)(?:[^/]+\.(?:[cm]?[jt]sx?|json)|[^/]+\.d\.ts)$/u;

export function selectTypeScriptModelPaths(input: SelectTypeScriptModelPathsInput): readonly string[] {
  const openFileRank = new Map(input.priorityPaths.map((path, index) => [path, index]));
  const projectPaths = input.files
    .filter((file) => file.kind === "text" && isProjectTypeScriptModelPath(file.path))
    .toSorted((left, right) => projectRank(left.path, openFileRank) - projectRank(right.path, openFileRank))
    .slice(0, PROJECT_TYPESCRIPT_MODEL_LIMIT)
    .map((file) => file.path);
  const declarationPaths = input.files
    .filter((file) => file.kind === "text" && isDirectDependencyDeclarationPath(file.path, input.packageNames))
    .toSorted((left, right) => declarationRank(left.path) - declarationRank(right.path) || left.path.localeCompare(right.path))
    .slice(0, DEPENDENCY_DECLARATION_LIMIT)
    .map((file) => file.path);
  return [...projectPaths, ...declarationPaths];
}

export function isProjectTypeScriptModelPath(path: string): boolean {
  if (isHiddenPackagePath(path) || path.split("/").includes("node_modules")) return false;
  return TYPESCRIPT_MODEL_PATH.test(path);
}

export function isDirectDependencyDeclarationPath(path: string, packageNames: ReadonlySet<string>): boolean {
  if (!path.endsWith(".d.ts") || isHiddenPackagePath(path)) return false;
  const parts = path.split("/");
  const nodeModulesIndex = parts.indexOf("node_modules");
  if (nodeModulesIndex < 0 || nodeModulesIndex !== parts.lastIndexOf("node_modules")) return false;
  const packageName = dependencyPackageName(parts.slice(nodeModulesIndex + 1));
  if (packageName === undefined) return false;
  if (packageNames.has(packageName)) return true;
  if (!packageName.startsWith("@types/")) return false;
  return packageNames.has(typedPackageName(packageName));
}

function isHiddenPackagePath(path: string): boolean {
  return path.split("/").some((segment) => segment === ".pnpm" || segment === ".pnpm-store");
}

function dependencyPackageName(segmentsAfterNodeModules: readonly string[]): string | undefined {
  const first = segmentsAfterNodeModules[0];
  if (first === undefined || first === ".bin") return undefined;
  if (!first.startsWith("@")) return first;
  const second = segmentsAfterNodeModules[1];
  if (second === undefined) return undefined;
  return `${first}/${second}`;
}

function typedPackageName(packageName: string): string {
  const bareName = packageName.slice("@types/".length);
  const scopeBreak = bareName.indexOf("__");
  if (scopeBreak < 0) return bareName;
  return `@${bareName.slice(0, scopeBreak)}/${bareName.slice(scopeBreak + 2)}`;
}

function projectRank(path: string, openFileRank: ReadonlyMap<string, number>): number {
  const openRank = openFileRank.get(path);
  if (openRank !== undefined) return OPEN_FILE_RANK + openRank;
  if (path === "package.json" || /(?:^|\/)tsconfig[^/]*\.json$/u.test(path)) return PROJECT_CONFIG_RANK;
  if (path.endsWith(".d.ts")) return PROJECT_DECLARATION_RANK;
  return PROJECT_SOURCE_RANK;
}

function declarationRank(path: string): number {
  if (path.endsWith("/index.d.ts")) return DECLARATION_INDEX_RANK;
  if (path.includes("/jsx-runtime")) return DECLARATION_JSX_RUNTIME_RANK;
  if (path.includes("/@types/")) return DECLARATION_TYPES_RANK;
  return DECLARATION_OTHER_RANK;
}
