import * as monaco from "monaco-editor";

import { editorLanguageForPath } from "@/projects/_utils/project-editor-language.ts";
import { selectTypeScriptModelPaths } from "@/projects/_utils/project-typescript-models.ts";
import { packageNamesFromManifest, projectTypeScriptOptionsFromWorkspace } from "@/projects/_utils/project-typescript-options.ts";
import type { ProjectTypeScriptOptions } from "@/projects/_utils/project-typescript-options.ts";

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

const MANIFEST_PATH = "package.json";
const WORKSPACE_DECLARATIONS_PATH = "__nuriteo__/workspace-modules.d.ts";
const managedModelsByProject = new Map<string, Set<string>>();
let typescriptDefaultsConfigured = false;

export function configureMonacoTypeScript(): void {
  if (typescriptDefaultsConfigured) return;
  typescriptDefaultsConfigured = true;

  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ onlyVisible: true });
    defaults.setEagerModelSync(true);
  }
}

export function monacoModelPath(projectKey: string, path: string): string {
  return monacoModelUri(projectKey, path).toString();
}

export function syncProjectMonacoWorkspace(input: SyncProjectWorkspaceInput): void {
  configureMonacoTypeScript();
  applyProjectTypeScriptOptions(input);
  const managedUris = managedModelsByProject.get(input.projectKey) ?? new Set<string>();
  const nextManagedUris = new Set<string>();
  const selectedFiles = selectWorkspaceFiles(input);

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
      monaco.editor.createModel(value, editorLanguageForPath(file.path), uri);
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

function selectWorkspaceFiles(input: SyncProjectWorkspaceInput): readonly ProjectTextFile[] {
  const filesByPath = new Map(input.files.filter((file) => file.kind === "text").map((file) => [file.path, file]));
  const packageNames = new Set(packageNamesFromManifest(readManifest(input)));
  return selectTypeScriptModelPaths({
    files: input.files,
    packageNames,
    priorityPaths: input.priorityPaths
  }).flatMap((path) => {
    const file = filesByPath.get(path);
    return file === undefined ? [] : [file];
  });
}

function applyProjectTypeScriptOptions(input: SyncProjectWorkspaceInput): void {
  const options = projectTypeScriptOptionsFromWorkspace((path) => {
    try {
      return input.readText(path);
    } catch {
      return undefined;
    }
  });
  const compilerOptions = monacoCompilerOptions(options);
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptions);
  }
}

function monacoCompilerOptions(options: ProjectTypeScriptOptions): monaco.typescript.CompilerOptions {
  const compilerOptions: monaco.typescript.CompilerOptions = {
    allowImportingTsExtensions: true,
    allowJs: options.allowJs,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: options.allowSyntheticDefaultImports,
    checkJs: options.checkJs,
    esModuleInterop: options.esModuleInterop,
    experimentalDecorators: options.experimentalDecorators,
    forceConsistentCasingInFileNames: options.forceConsistentCasingInFileNames,
    isolatedModules: options.isolatedModules,
    jsx: monacoJsx(options.jsx),
    module: options.module === "commonjs" ? monaco.typescript.ModuleKind.CommonJS : monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    noEmit: true,
    noUnusedLocals: options.noUnusedLocals,
    noUnusedParameters: options.noUnusedParameters,
    resolveJsonModule: options.resolveJsonModule,
    skipLibCheck: options.skipLibCheck,
    strict: options.strict,
    target: monacoTarget(options.target)
  };
  if (options.baseUrl !== undefined) compilerOptions.baseUrl = options.baseUrl;
  if (options.lib !== undefined) compilerOptions.lib = [...options.lib];
  if (options.paths !== undefined) compilerOptions.paths = copyPaths(options.paths);
  return compilerOptions;
}

function monacoJsx(jsx: ProjectTypeScriptOptions["jsx"]): monaco.typescript.JsxEmit {
  switch (jsx) {
    case "preserve":
      return monaco.typescript.JsxEmit.Preserve;
    case "react":
      return monaco.typescript.JsxEmit.React;
    case "react-jsx":
      return monaco.typescript.JsxEmit.ReactJSX;
    case "react-jsxdev":
      return monaco.typescript.JsxEmit.ReactJSXDev;
    case "react-native":
      return monaco.typescript.JsxEmit.ReactNative;
    default: {
      const unreachable: never = jsx;
      return unreachable;
    }
  }
}

function monacoTarget(target: ProjectTypeScriptOptions["target"]): monaco.typescript.ScriptTarget {
  switch (target) {
    case "es5":
      return monaco.typescript.ScriptTarget.ES5;
    case "es2015":
      return monaco.typescript.ScriptTarget.ES2015;
    case "es2016":
      return monaco.typescript.ScriptTarget.ES2016;
    case "es2017":
      return monaco.typescript.ScriptTarget.ES2017;
    case "es2018":
      return monaco.typescript.ScriptTarget.ES2018;
    case "es2019":
      return monaco.typescript.ScriptTarget.ES2019;
    case "es2020":
      return monaco.typescript.ScriptTarget.ES2020;
    case "esnext":
      return monaco.typescript.ScriptTarget.ESNext;
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
}

function copyPaths(paths: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  const copy: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(paths)) copy[key] = [...value];
  return copy;
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
  const moduleNames = packageNamesFromManifest(manifestText);
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


