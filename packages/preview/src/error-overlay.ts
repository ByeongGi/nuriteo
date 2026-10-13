import type { PreviewDiagnostic, PreviewErrorDiagnosticInput, PreviewRecoveryAction } from "./types.ts";

export function createPreviewErrorDiagnostic(input: PreviewErrorDiagnosticInput, at = Date.now()): PreviewDiagnostic {
  const diagnostic: PreviewDiagnostic = {
    at,
    source: input.source,
    level: "error",
    message: input.message,
    recoveryActions: normalizeRecoveryActions(input)
  };
  if (input.clientId) diagnostic.clientId = input.clientId;
  if (input.code) diagnostic.code = input.code;
  if (input.column !== undefined) diagnostic.column = input.column;
  if (input.file) diagnostic.file = input.file;
  if (input.line !== undefined) diagnostic.line = input.line;
  if (input.stack) diagnostic.stack = input.stack;
  return diagnostic;
}

function normalizeRecoveryActions(input: PreviewErrorDiagnosticInput): PreviewRecoveryAction[] {
  if (input.recoveryActions) return input.recoveryActions.map((action) => ({ ...action }));
  const actions: PreviewRecoveryAction[] = [];
  if (input.file) actions.push({ kind: "open-file", label: "Open file", path: input.file });
  if (input.source === "build") actions.push({ kind: "rerun-build", label: "Rerun build", command: "npm run build" });
  if (input.source === "hmr") actions.push({ kind: "restart-dev-server", label: "Restart dev server" });
  if (input.source === "runtime") actions.push({ kind: "show-terminal", label: "Show terminal" });
  return actions;
}
