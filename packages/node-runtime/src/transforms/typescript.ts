import ts from "typescript";

export interface TypeScriptTransformOptions {
  fileName?: string;
}

export interface RuntimeDiagnostic {
  code: number;
  category: string;
  message: string;
  fileName?: string;
  line: number | null;
  column: number | null;
}

export function transpileTypeScript(source: string, options: TypeScriptTransformOptions = {}): {
  code: string;
  map: unknown;
  diagnostics: RuntimeDiagnostic[];
} {
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
    map: sourceMapText ? JSON.parse(sourceMapText) as unknown : null,
    diagnostics: normalizeDiagnostics(result.diagnostics || [])
  };
}

export function normalizeDiagnostics(diagnostics: readonly ts.Diagnostic[]): RuntimeDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const position = diagnostic.file && typeof diagnostic.start === "number"
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : null;
    const output: RuntimeDiagnostic = {
      code: diagnostic.code,
      category: ts.DiagnosticCategory[diagnostic.category],
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      line: position ? position.line + 1 : null,
      column: position ? position.character + 1 : null
    };
    if (diagnostic.file?.fileName !== undefined) output.fileName = diagnostic.file.fileName;
    return output;
  });
}
