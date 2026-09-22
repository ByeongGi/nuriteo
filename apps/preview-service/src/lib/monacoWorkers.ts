import * as monaco from "monaco-editor";

const WORKER_READY_TIMEOUT_MS = 30_000;
let configuration: Promise<MonacoWorkerStatus> | null = null;

export type MonacoWorkerStatus = {
  loader: "bundler" | "getWorker" | "getWorkerUrl";
  typescriptDiagnostics: number;
};

export type MonacoLanguageFeatureStatus = {
  definitionFiles: string[];
  quickInfoKind: string | null;
  completionNames: string[];
  diagnosticCount: number;
};

/**
 * Monaco 0.56 declares module workers with `new URL(..., import.meta.url)`.
 * Vite 8 bundles those URLs directly; no legacy worker plugin or no-op fallback
 * is required.
 */
export async function configureMonacoWorkers(): Promise<void> {
  if (typeof self === "undefined") return;
  configuration ||= initializeMonacoWorkers();
  await configuration;
}

async function initializeMonacoWorkers(): Promise<MonacoWorkerStatus> {
  try {
    const ts = monaco.typescript;
    if (ts?.typescriptDefaults) {
      ts.typescriptDefaults.setEagerModelSync(true);
      ts.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false
      });
      ts.typescriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ES2022,
        allowNonTsExtensions: true,
        allowImportingTsExtensions: true,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        allowJs: true,
        checkJs: false,
        esModuleInterop: true,
        noEmit: true
      });
    }
    if (ts?.javascriptDefaults) {
      ts.javascriptDefaults.setEagerModelSync(true);
      ts.javascriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ES2022,
        allowNonTsExtensions: true,
        allowImportingTsExtensions: true,
        allowJs: true,
        checkJs: false,
        noEmit: true,
        jsx: ts.JsxEmit.ReactJSX
      });
    }
    return await runTypeScriptWorkerProbe();
  } catch (error) {
    configuration = null;
    throw new Error("Monaco language worker initialization failed.", {
      cause: error
    });
  }
}

/**
 * Exercise the TypeScript language service with a semantic error. This is used
 * by browser smoke tests and can also back a host readiness check.
 */
export async function probeMonacoTypeScriptWorker(): Promise<MonacoWorkerStatus> {
  if (typeof self === "undefined") throw new Error("Monaco language workers require a browser context.");
  configuration ||= initializeMonacoWorkers();
  return configuration;
}

/** Verify the semantic features used by completion, hover, and go-to-definition. */
export async function probeMonacoLanguageFeatures(): Promise<MonacoLanguageFeatureStatus> {
  await configureMonacoWorkers();
  const definitionUri = monaco.Uri.parse("file:///__cargo_language_probe__/answer.ts");
  const consumerUri = monaco.Uri.parse("file:///__cargo_language_probe__/consumer.ts");
  const definitionModel = monaco.editor.createModel("export const answer: number = 42;\n", "typescript", definitionUri);
  const consumerSource = ['import { answer } from "./answer";', "answer.toFixed(2);", "answer."].join("\n");
  const consumerModel = monaco.editor.createModel(consumerSource, "typescript", consumerUri);

  try {
    const getWorker = await getRegisteredTypeScriptWorker();
    const worker = await getWorker(consumerUri);
    const fileName = consumerUri.toString();
    const definitionOffset = consumerSource.indexOf("answer.toFixed");
    const completionOffset = consumerSource.lastIndexOf("answer.") + "answer.".length;
    const [definitions, quickInfo, completions, diagnostics] = await Promise.all([
      worker.getDefinitionAtPosition(fileName, definitionOffset),
      worker.getQuickInfoAtPosition(fileName, definitionOffset),
      worker.getCompletionsAtPosition(fileName, completionOffset),
      worker.getSemanticDiagnostics(fileName)
    ]);

    return {
      definitionFiles: definitions?.map((entry) => entry.fileName) || [],
      quickInfoKind: quickInfo?.kind || null,
      completionNames: completions?.entries.map((entry) => entry.name) || [],
      diagnosticCount: diagnostics.length
    };
  } finally {
    definitionModel.dispose();
    consumerModel.dispose();
  }
}

async function runTypeScriptWorkerProbe(): Promise<MonacoWorkerStatus> {
  const env = self.MonacoEnvironment;
  let loader: MonacoWorkerStatus["loader"] = "bundler";
  if (typeof env?.getWorker === "function") loader = "getWorker";
  else if (typeof env?.getWorkerUrl === "function") loader = "getWorkerUrl";
  const uri = monaco.Uri.parse("file:///__cargo_monaco_worker_probe__.ts");
  const existing = monaco.editor.getModel(uri);
  const model = existing || monaco.editor.createModel("const cargoProbe: string = 42;\n", "typescript", uri);

  try {
    const getWorker = await getRegisteredTypeScriptWorker();
    const worker = await getWorker(uri);
    const diagnostics = await withTimeout(
      waitForProbeDiagnostics(worker, uri.toString()),
      WORKER_READY_TIMEOUT_MS,
      "Monaco TypeScript worker readiness timed out."
    );
    if (diagnostics.length === 0) throw new Error("Monaco TypeScript worker returned no probe diagnostic.");
    return { loader, typescriptDiagnostics: diagnostics.length };
  } finally {
    if (!existing) model.dispose();
  }
}

async function waitForProbeDiagnostics(
  worker: monaco.languages.typescript.TypeScriptWorker,
  fileName: string
): Promise<monaco.languages.typescript.Diagnostic[]> {
  const retryIntervalMs = 25;
  const maxAttempts = Math.ceil(WORKER_READY_TIMEOUT_MS / retryIntervalMs);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const diagnostics = await worker.getSemanticDiagnostics(fileName);
    if (diagnostics.length > 0) return diagnostics;
    await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
  }
  throw new Error("Monaco TypeScript worker returned no probe diagnostic.");
}

async function getRegisteredTypeScriptWorker() {
  // Monaco registers a language asynchronously after its first model appears.
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS;
  while (true) {
    try {
      return await monaco.typescript.getTypeScriptWorker();
    } catch (error) {
      if (error !== "TypeScript not registered!" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
