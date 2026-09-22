import * as monaco from "monaco-editor";

export type LanguageProblemSeverity = "error" | "warning" | "info";

export interface LanguageProblem {
  id: string;
  path: string;
  message: string;
  severity: LanguageProblemSeverity;
  source: string;
  code?: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

const INTERNAL_MODEL_PREFIXES = ["/__cargo_", "/__cargo_split__"];

function problemSeverity(
  severity: monaco.MarkerSeverity,
): LanguageProblemSeverity {
  if (severity === monaco.MarkerSeverity.Error) return "error";
  if (severity === monaco.MarkerSeverity.Warning) return "warning";
  return "info";
}

export function workspacePathForModel(
  model: monaco.editor.ITextModel | null,
): string | null {
  if (!model || model.uri.scheme !== "file") return null;
  const path = model.uri.path;
  if (
    !path ||
    INTERNAL_MODEL_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
    return null;
  return path;
}

export function collectLanguageProblems(): LanguageProblem[] {
  const problems: LanguageProblem[] = [];

  for (const marker of monaco.editor.getModelMarkers({})) {
    if (marker.resource.scheme !== "file") continue;
    const path = marker.resource.path;
    if (
      !path ||
      INTERNAL_MODEL_PREFIXES.some((prefix) => path.startsWith(prefix))
    )
      continue;

    problems.push({
      id: [
        marker.owner,
        path,
        marker.startLineNumber,
        marker.startColumn,
        marker.code?.toString() || "",
        marker.message,
      ].join(":"),
      path,
      message: marker.message,
      severity: problemSeverity(marker.severity),
      source: marker.source || marker.owner || "language-service",
      code: marker.code?.toString(),
      line: marker.startLineNumber,
      column: marker.startColumn,
      endLine: marker.endLineNumber,
      endColumn: marker.endColumn,
    });
  }

  return problems.sort((left, right) => {
    const severityOrder = { error: 0, warning: 1, info: 2 } as const;
    return (
      severityOrder[left.severity] - severityOrder[right.severity] ||
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column
    );
  });
}

export function subscribeToLanguageProblems(
  listener: (problems: LanguageProblem[]) => void,
): monaco.IDisposable {
  let frame: number | null = null;

  const publish = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      listener(collectLanguageProblems());
    });
  };

  const subscription = monaco.editor.onDidChangeMarkers(publish);
  publish();

  return {
    dispose() {
      subscription.dispose();
      if (frame !== null) cancelAnimationFrame(frame);
    },
  };
}
