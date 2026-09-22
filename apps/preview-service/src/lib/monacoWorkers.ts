import * as monaco from "monaco-editor";

const WORKER_READY_TIMEOUT_MS = 30_000;
let configuration: Promise<MonacoWorkerStatus> | null = null;

export type MonacoWorkerStatus = {
  loader: "bundler" | "getWorker" | "getWorkerUrl";
  typescriptDiagnostics: number;
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
        allowJs: true,
        checkJs: false,
        noEmit: true,
        jsx: ts.JsxEmit.ReactJSX
      });
    }
    return await runTypeScriptWorkerProbe();
  } catch (error) {
    configuration = null;
    throw new Error("Monaco language worker initialization failed.", { cause: error });
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

async function runTypeScriptWorkerProbe(): Promise<MonacoWorkerStatus> {
  const env = self.MonacoEnvironment;
  let loader: MonacoWorkerStatus["loader"] = "bundler";
  if (typeof env?.getWorker === "function") loader = "getWorker";
  else if (typeof env?.getWorkerUrl === "function") loader = "getWorkerUrl";
  const uri = monaco.Uri.parse("file:///__cargo_monaco_worker_probe__.ts");
  const existing = monaco.editor.getModel(uri);
  const model = existing || monaco.editor.createModel("const cargoProbe: string = 42;\n", "typescript", uri);

  try {
    const getWorker = await monaco.typescript.getTypeScriptWorker();
    const worker = await getWorker(uri);
    const diagnostics = await withTimeout(
      worker.getSemanticDiagnostics(uri.toString()),
      WORKER_READY_TIMEOUT_MS,
      "Monaco TypeScript worker readiness timed out."
    );
    if (diagnostics.length === 0) throw new Error("Monaco TypeScript worker returned no probe diagnostic.");
    return { loader, typescriptDiagnostics: diagnostics.length };
  } finally {
    if (!existing) model.dispose();
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
