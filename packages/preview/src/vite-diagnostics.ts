import { createPreviewErrorDiagnostic } from "./error-overlay.ts";
import { originalPreviewPositionFor, type PreviewSourceMap } from "./source-map.ts";
import type { PreviewDiagnostic, PreviewErrorCode, PreviewErrorStage, PreviewRecoveryAction } from "./types.ts";

export interface VitePreviewFailureInput {
  clientId?: string;
  code?: PreviewErrorCode;
  command?: string;
  error: unknown;
  file?: string;
  line?: number;
  column?: number;
  source: PreviewErrorStage;
  sourceMap?: PreviewSourceMap;
}

export function createVitePreviewErrorDiagnostic(input: VitePreviewFailureInput, at = Date.now()): PreviewDiagnostic {
  const details = extractFailureDetails(input);
  const mapped = mapFailurePosition(details, input.sourceMap);
  return createPreviewErrorDiagnostic({
    source: input.source,
    message: details.message,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    code: input.code || codeFor(input.source),
    ...(mapped.file ? { file: mapped.file } : {}),
    ...(mapped.line !== undefined ? { line: mapped.line } : {}),
    ...(mapped.column !== undefined ? { column: mapped.column } : {}),
    recoveryActions: recoveryActionsFor(input, mapped.file),
    ...(details.stack ? { stack: details.stack } : {})
  }, at);
}

function extractFailureDetails(input: VitePreviewFailureInput): {
  column?: number;
  file?: string;
  line?: number;
  message: string;
  stack?: string;
} {
  const error = input.error;
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const location = parseLocation(`${input.file || ""}\n${message}\n${stack || ""}`);
  return {
    message,
    ...(input.file || location.file ? { file: input.file || location.file } : {}),
    ...(input.line ?? location.line ? { line: input.line ?? location.line } : {}),
    ...(input.column ?? location.column ? { column: input.column ?? location.column } : {}),
    ...(stack ? { stack } : {})
  };
}

function mapFailurePosition(
  details: { column?: number; file?: string; line?: number },
  sourceMap?: PreviewSourceMap
): { column?: number; file?: string; line?: number } {
  if (!sourceMap || details.line === undefined || details.column === undefined) return details;
  const original = originalPreviewPositionFor(sourceMap, details.line, details.column);
  if (!original) return details;
  return {
    ...(original.source || details.file ? { file: original.source || details.file } : {}),
    line: original.line,
    column: original.column
  };
}

function parseLocation(value: string): { column?: number; file?: string; line?: number } {
  const match = value.match(/((?:\/|\w)[\w./-]+\.[cm]?[jt]sx?):(\d+):(\d+)/);
  if (!match) return {};
  return {
    ...(match[1] ? { file: match[1] } : {}),
    line: Number(match[2]),
    column: Number(match[3])
  };
}

function codeFor(source: PreviewErrorStage): PreviewErrorCode {
  if (source === "build") return "EVITEBUILD";
  if (source === "hmr") return "EVITEHMR";
  return "EVITERUNTIME";
}

function recoveryActionsFor(input: VitePreviewFailureInput, mappedFile?: string): PreviewRecoveryAction[] {
  const actions: PreviewRecoveryAction[] = [];
  const file = mappedFile || input.file;
  if (file) actions.push({ kind: "open-file", label: "Open file", path: file });
  if (input.source === "build") actions.push({ kind: "rerun-build", label: "Rerun build", command: input.command || "npm run build" });
  if (input.source === "hmr") actions.push({ kind: "restart-dev-server", label: "Restart dev server" });
  if (input.source === "runtime") actions.push({ kind: "show-terminal", label: "Show terminal" });
  return actions;
}
