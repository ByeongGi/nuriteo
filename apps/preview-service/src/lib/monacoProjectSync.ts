import * as monaco from "monaco-editor";

const synced = new Map<string, string>();

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

    const nextPaths = new Set<string>();
    for (const file of files) {
      if (!/\.(?:[cm]?[jt]sx?|mjs|cjs|json|css|html)$/.test(file.path)) continue;
      nextPaths.add(file.path);
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
        const libPath = `file://${file.path}`;
        if (synced.get(file.path) !== file.data) {
          tsDefaults.addExtraLib(file.data, libPath);
          jsDefaults.addExtraLib(file.data, libPath);
          synced.set(file.path, file.data);
        }
      }
    }

    for (const model of monaco.editor.getModels()) {
      const path = model.uri.path;
      if (!path || nextPaths.has(path)) continue;
      if (path.includes("/node_modules/")) continue;
      if ([...synced.keys()].some((entry) => entry === path || entry.endsWith(path))) {
        model.dispose();
      }
    }

    for (const path of [...synced.keys()]) {
      if (!nextPaths.has(path)) synced.delete(path);
    }
  } catch {
    // IntelliSense sync is best-effort; never crash the IDE shell.
  }
}
