import * as monaco from "monaco-editor";
import { createMonacoTypeLibraries } from "./monacoTypeLibraries";

const synced = new Map<string, { data: string; disposables: monaco.IDisposable[] }>();
const syncedTypeLibraries = new Map<string, { data: string; disposables: monaco.IDisposable[] }>();

function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".jsx") || lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  return "plaintext";
}

export function monacoModelPath(path: string): string {
  // Monaco TS service resolves better with file:// style paths.
  return `file://${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizedPath(path: string): string {
  return monaco.Uri.parse(monacoModelPath(path)).path;
}

function uriForPath(path: string): monaco.Uri {
  return monaco.Uri.parse(monacoModelPath(path));
}

/**
 * Keep Monaco text models + TS extraLibs aligned with the project workspace
 * so IntelliSense / go-to-definition can see cross-file symbols.
 */
export function syncMonacoProjectFiles(files: Array<{ path: string; data: string }>): void {
  try {
    if (!monaco.editor || !monaco.languages) return;
    const tsDefaults = monaco.typescript.typescriptDefaults;
    const jsDefaults = monaco.typescript.javascriptDefaults;

    syncTypeLibraries(files, tsDefaults, jsDefaults);

    const nextPaths = new Set<string>();
    for (const file of files) {
      if (!/\.(?:[cm]?[jt]sx?|mjs|cjs|json|css|html)$/.test(file.path)) continue;
      const normalized = normalizedPath(file.path);
      nextPaths.add(normalized);
      const uri = uriForPath(file.path);
      const existing = monaco.editor.getModel(uri);
      const language = languageForPath(file.path);
      if (existing) {
        if (existing.getValue() !== file.data) {
          existing.setValue(file.data);
        }
      } else {
        monaco.editor.createModel(file.data, language, uri);
      }

      if ((language === "typescript" || language === "javascript") && tsDefaults && jsDefaults) {
        const current = synced.get(normalized);
        if (current?.data !== file.data) {
          current?.disposables.forEach((disposable) => disposable.dispose());
          const libPath = monacoModelPath(file.path);
          synced.set(normalized, {
            data: file.data,
            disposables: [tsDefaults.addExtraLib(file.data, libPath), jsDefaults.addExtraLib(file.data, libPath)]
          });
        }
      }
    }

    for (const model of monaco.editor.getModels()) {
      const path = model.uri.path;
      if (!path || nextPaths.has(path)) continue;
      if (path.includes("/node_modules/")) continue;
      if (synced.has(path)) {
        model.dispose();
      }
    }

    for (const path of [...synced.keys()]) {
      if (nextPaths.has(path)) continue;
      synced.get(path)?.disposables.forEach((disposable) => disposable.dispose());
      synced.delete(path);
    }
  } catch {
    // IntelliSense sync is best-effort; never crash the IDE shell.
  }
}

function syncTypeLibraries(
  files: Array<{ path: string; data: string }>,
  tsDefaults: typeof monaco.typescript.typescriptDefaults,
  jsDefaults: typeof monaco.typescript.javascriptDefaults
): void {
  const nextPaths = new Set<string>();
  for (const library of createMonacoTypeLibraries(files)) {
    nextPaths.add(library.path);
    const current = syncedTypeLibraries.get(library.path);
    if (current?.data === library.data) continue;
    current?.disposables.forEach((disposable) => disposable.dispose());
    syncedTypeLibraries.set(library.path, {
      data: library.data,
      disposables: [
        tsDefaults.addExtraLib(library.data, library.path),
        jsDefaults.addExtraLib(library.data, library.path)
      ]
    });
  }

  for (const path of [...syncedTypeLibraries.keys()]) {
    if (nextPaths.has(path)) continue;
    syncedTypeLibraries.get(path)?.disposables.forEach((disposable) => disposable.dispose());
    syncedTypeLibraries.delete(path);
  }
}
