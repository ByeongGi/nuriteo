import * as monaco from "monaco-editor";

interface ProjectTextFile {
  readonly kind: "text" | "binary";
  readonly path: string;
}

interface SyncProjectWorkspaceInput {
  readonly files: readonly ProjectTextFile[];
  readonly priorityPaths: readonly string[];
  readonly projectKey: string;
  readonly readText: (path: string) => string;
}

const MAX_SYNCED_SOURCE_MODELS = 500;
const MANIFEST_PATH = "package.json";
const SUPPORTED_MODEL_PATH = /(?:^|\/)(?:[^/]+\.(?:[cm]?[jt]sx?|json)|[^/]+\.d\.ts)$/u;
const WORKSPACE_DECLARATIONS_PATH = "__nuriteo__/workspace-modules.d.ts";
const managedModelsByProject = new Map<string, Set<string>>();
let typescriptDefaultsConfigured = false;

export function configureMonacoTypeScript(): void {
  if (typescriptDefaultsConfigured) return;
  typescriptDefaultsConfigured = true;

  const compilerOptions: monaco.typescript.CompilerOptions = {
    allowImportingTsExtensions: true,
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    jsx: monaco.typescript.JsxEmit.Preserve,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    noEmit: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    target: monaco.typescript.ScriptTarget.ESNext
  };

  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptions);
    defaults.setDiagnosticsOptions({ onlyVisible: true });
    defaults.setEagerModelSync(true);
  }
}

export function monacoModelPath(projectKey: string, path: string): string {
  return monacoModelUri(projectKey, path).toString();
}

export function syncProjectMonacoWorkspace(input: SyncProjectWorkspaceInput): void {
  configureMonacoTypeScript();
  const managedUris = managedModelsByProject.get(input.projectKey) ?? new Set<string>();
  const nextManagedUris = new Set<string>();
  const selectedFiles = selectWorkspaceFiles(input.files, input.priorityPaths);

  for (const file of selectedFiles) {
    let value: string;
    try {
      value = input.readText(file.path);
    } catch {
      continue;
    }
    const uri = monacoModelUri(input.projectKey, file.path);
    nextManagedUris.add(uri.toString());
    const model = monaco.editor.getModel(uri);
    if (model === null) {
      monaco.editor.createModel(value, languageForPath(file.path), uri);
    } else if (model.getValue() !== value && !isModelAttachedToEditor(model)) {
      model.setValue(value);
    }
  }

  const declarationUri = monacoModelUri(input.projectKey, WORKSPACE_DECLARATIONS_PATH);
  const declarationValue = workspaceDeclarations(readManifest(input));
  nextManagedUris.add(declarationUri.toString());
  const declarationModel = monaco.editor.getModel(declarationUri);
  if (declarationModel === null) {
    monaco.editor.createModel(declarationValue, "typescript", declarationUri);
  } else if (declarationModel.getValue() !== declarationValue) {
    declarationModel.setValue(declarationValue);
  }

  for (const uri of managedUris) {
    if (nextManagedUris.has(uri)) continue;
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model !== null && !isModelAttachedToEditor(model)) model.dispose();
  }
  managedModelsByProject.set(input.projectKey, nextManagedUris);
}

export function disposeProjectMonacoWorkspace(projectKey: string): void {
  const managedUris = managedModelsByProject.get(projectKey);
  if (managedUris === undefined) return;
  managedModelsByProject.delete(projectKey);
  for (const uri of managedUris) monaco.editor.getModel(monaco.Uri.parse(uri))?.dispose();
}

function selectWorkspaceFiles(files: readonly ProjectTextFile[], priorityPaths: readonly string[]): readonly ProjectTextFile[] {
  const priority = new Map(priorityPaths.map((path, index) => [path, index]));
  return files
    .filter((file) => file.kind === "text" && SUPPORTED_MODEL_PATH.test(file.path))
    .toSorted((left, right) => filePriority(left.path, priority) - filePriority(right.path, priority))
    .slice(0, MAX_SYNCED_SOURCE_MODELS);
}

function filePriority(path: string, priority: ReadonlyMap<string, number>): number {
  const openFileIndex = priority.get(path);
  if (openFileIndex !== undefined) return openFileIndex;
  if (path === MANIFEST_PATH || /(?:^|\/)tsconfig[^/]*\.json$/u.test(path)) return 1_000;
  if (path.endsWith(".d.ts")) return 2_000;
  return 3_000;
}

function readManifest(input: SyncProjectWorkspaceInput): string | undefined {
  if (!input.files.some((file) => file.kind === "text" && file.path === MANIFEST_PATH)) return undefined;
  try {
    return input.readText(MANIFEST_PATH);
  } catch {
    return undefined;
  }
}

function workspaceDeclarations(manifestText: string | undefined): string {
  const moduleNames = packageNames(manifestText);
  const declarations = [
    "declare namespace JSX {",
    "  interface IntrinsicElements { [elementName: string]: any; }",
    "}",
    ...["css", "less", "scss", "sass", "svg", "png", "jpg", "jpeg", "gif", "webp"].map((extension) => `declare module \"*.${extension}\";`)
  ];
  for (const moduleName of moduleNames) {
    declarations.push(`declare module ${JSON.stringify(moduleName)};`);
    declarations.push(`declare module ${JSON.stringify(`${moduleName}/*`)};`);
  }
  return `${declarations.join("\n")}\n`;
}

function packageNames(manifestText: string | undefined): readonly string[] {
  if (manifestText === undefined) return [];
  try {
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
      const dependencies = manifest[field];
      if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
      for (const name of Object.keys(dependencies)) {
        if (!name.startsWith("@types/")) names.add(name);
      }
    }
    return [...names].toSorted();
  } catch {
    return [];
  }
}

function monacoModelUri(projectKey: string, path: string): monaco.Uri {
  const normalizedPath = path.replace(/^\/+|\.{2,}(?:\/|$)/gu, "");
  return monaco.Uri.from({
    scheme: "file",
    path: `/nuriteo/${encodeURIComponent(projectKey)}/${normalizedPath}`
  });
}

function isModelAttachedToEditor(model: monaco.editor.ITextModel): boolean {
  return monaco.editor.getEditors().some((editor) => editor.getModel() === model);
}

function languageForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLocaleLowerCase();
  const languages: Readonly<Record<string, string>> = {
    cjs: "javascript",
    css: "css",
    html: "html",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    less: "less",
    md: "markdown",
    mjs: "javascript",
    scss: "scss",
    ts: "typescript",
    tsx: "typescript"
  };
  return extension === undefined ? "plaintext" : languages[extension] ?? "plaintext";
}
