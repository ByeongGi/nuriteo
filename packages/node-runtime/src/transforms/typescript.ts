import ts from "typescript";

export function transpileTypeScript(source, options = {}) {
  const fileName = options.fileName || "/workspace/index.ts";
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
      inlineSources: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove
    }
  });

  const sourceMapText = result.sourceMapText || "";
  return {
    code: result.outputText,
    map: sourceMapText ? JSON.parse(sourceMapText) : null,
    diagnostics: normalizeDiagnostics(result.diagnostics || [])
  };
}

export function normalizeDiagnostics(diagnostics) {
  return diagnostics.map((diagnostic) => {
    const position = diagnostic.file && typeof diagnostic.start === "number"
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : null;
    return {
      code: diagnostic.code,
      category: ts.DiagnosticCategory[diagnostic.category],
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      fileName: diagnostic.file?.fileName,
      line: position ? position.line + 1 : null,
      column: position ? position.character + 1 : null
    };
  });
}
