import * as monaco from "monaco-editor";

let configured = false;

/**
 * Real Monaco language workers are provided by `vite-plugin-monaco-editor`
 * (esbuild-prebundled, same-origin under /monacoeditorwork).
 *
 * Vite 8/Rolldown cannot resolve monaco-editor deep `*.worker?worker` imports,
 * so we intentionally do NOT use Vite's `?worker` pipeline here.
 */
export async function configureMonacoWorkers(): Promise<void> {
  if (configured || typeof self === "undefined") return;
  configured = true;

  const env = self.MonacoEnvironment;
  const hasRealWorkerLoader = Boolean(
    env && (typeof env.getWorkerUrl === "function" || typeof env.getWorker === "function")
  );

  if (!hasRealWorkerLoader) {
    const blob = new Blob(["self.onmessage = () => {};"], { type: "text/javascript" });
    const workerUrl = URL.createObjectURL(blob);
    self.MonacoEnvironment = {
      getWorker() {
        return new Worker(workerUrl);
      }
    };
  }

  try {
    const ts = monaco.languages?.typescript;
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
  } catch {
    // Language defaults are best-effort.
  }
}
