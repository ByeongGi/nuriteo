import type { ImportMetaRewriteMode } from "./esm.ts";
import { prepareEsmSource } from "./esm.ts";

export function restoreImportMetaInStringLiterals(source: string): string {
  const output: string[] = [];
  type LexicalContext = {
    braceDepth?: number;
    type: "normal" | "template-expression" | "single" | "double" | "template" | "regex" | "line-comment" | "block-comment";
  };
  const contexts: LexicalContext[] = [{ type: "normal" }];
  let escaped = false;
  let inRegexClass = false;
  let previousSignificant = "";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] || "";
    const next = source[index + 1] || "";
    const context = contexts[contexts.length - 1];
    if (!context) break;

    if (context.type === "single" || context.type === "double" || context.type === "template") {
      if (source.startsWith("__context.importMeta", index)) {
        output.push("import.meta");
        index += "__context.importMeta".length - 1;
        continue;
      }
      output.push(char);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (context.type === "template" && char === "$" && next === "{") {
        output.push(next);
        index += 1;
        contexts.push({ type: "template-expression", braceDepth: 1 });
        previousSignificant = "{";
        continue;
      }
      if ((context.type === "single" && char === "'") || (context.type === "double" && char === "\"") || (context.type === "template" && char === "`")) {
        contexts.pop();
      }
      continue;
    }

    output.push(char);

    if (context.type === "regex") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "[") inRegexClass = true;
      if (char === "]") inRegexClass = false;
      if (char === "/" && !inRegexClass) contexts.pop();
      continue;
    }
    if (context.type === "line-comment") {
      if (char === "\n") contexts.pop();
      continue;
    }
    if (context.type === "block-comment") {
      if (char === "*" && next === "/") {
        output.push(next);
        index += 1;
        contexts.pop();
      }
      continue;
    }
    if (char === "/" && next === "/") {
      output.push(next);
      index += 1;
      contexts.push({ type: "line-comment" });
      continue;
    }
    if (char === "/" && next === "*") {
      output.push(next);
      index += 1;
      contexts.push({ type: "block-comment" });
      continue;
    }
    if (char === "/" && isRegexStart(previousSignificant)) {
      contexts.push({ type: "regex" });
      escaped = false;
      inRegexClass = false;
      previousSignificant = char;
      continue;
    }
    if (char === "'") {
      contexts.push({ type: "single" });
      escaped = false;
      continue;
    }
    if (char === "\"") {
      contexts.push({ type: "double" });
      escaped = false;
      continue;
    }
    if (char === "`") {
      contexts.push({ type: "template" });
      escaped = false;
      continue;
    }
    if (context.type === "template-expression") {
      if (char === "{") context.braceDepth = (context.braceDepth || 0) + 1;
      if (char === "}") {
        context.braceDepth = (context.braceDepth || 0) - 1;
        if (context.braceDepth === 0) contexts.pop();
      }
    }
    if (!/\s/.test(char)) previousSignificant = char;
  }

  return output.join("");
}


export function protectImportExportLinesInsideLiterals(source: string): { restore: (value: string) => string; source: string } {
  const importToken = "__NURITEO_LITERAL_IMPORT__";
  const exportToken = "__NURITEO_LITERAL_EXPORT__";
  const literalLineStarts = literalLineStartMask(source);
  const lines = source.split("\n");
  return {
    source: lines
      .map((line, index) => literalLineStarts[index]
        ? line
          .replace(/^([ \t]*)import(?=\s|["'{*])/, `$1${importToken}`)
          .replace(/^([ \t]*)export\b/, `$1${exportToken}`)
        : line)
      .join("\n"),
    restore: (value: string) => value
      .replaceAll(importToken, "import")
      .replaceAll(exportToken, "export")
  };
}


function literalLineStartMask(source: string): boolean[] {
  const mask: boolean[] = [false];
  const contexts: ("normal" | "single" | "double" | "template" | "template-expression")[] = ["normal"];
  const expressionBraceDepths: number[] = [];
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] || "";
    const next = source[index + 1] || "";
    const context = contexts[contexts.length - 1];

    if (char === "\n") {
      mask.push(contexts.some((item) => item === "single" || item === "double" || item === "template"));
      continue;
    }

    if (context === "single" || context === "double") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if ((context === "single" && char === "'") || (context === "double" && char === "\"")) contexts.pop();
      continue;
    }

    if (context === "template") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "$" && next === "{") {
        contexts.push("template-expression");
        expressionBraceDepths.push(1);
        index += 1;
        continue;
      }
      if (char === "`") contexts.pop();
      continue;
    }

    if (char === "'") {
      contexts.push("single");
      escaped = false;
      continue;
    }
    if (char === "\"") {
      contexts.push("double");
      escaped = false;
      continue;
    }
    if (char === "`") {
      contexts.push("template");
      escaped = false;
      continue;
    }

    if (context === "template-expression") {
      const last = expressionBraceDepths.length - 1;
      if (char === "{") expressionBraceDepths[last] = (expressionBraceDepths[last] || 0) + 1;
      if (char === "}") {
        const nextDepth = (expressionBraceDepths[last] || 0) - 1;
        if (nextDepth <= 0) {
          expressionBraceDepths.pop();
          contexts.pop();
        } else {
          expressionBraceDepths[last] = nextDepth;
        }
      }
    }
  }

  return mask;
}


export function stripBlockComments(source: string): string {
  const output: string[] = [];
  let state: "normal" | "single" | "double" | "template" | "regex" | "line-comment" | "block-comment" = "normal";
  let escaped = false;
  let inRegexClass = false;
  let previousSignificant = "";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] || "";
    const next = source[index + 1] || "";

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        output.push("  ");
        index += 1;
        state = "normal";
      } else {
        output.push(char === "\n" ? "\n" : " ");
      }
      continue;
    }

    if (state === "line-comment") {
      output.push(char);
      if (char === "\n") state = "normal";
      continue;
    }

    if (state === "single" || state === "double" || state === "template") {
      output.push(char);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if ((state === "single" && char === "'") || (state === "double" && char === "\"") || (state === "template" && char === "`")) {
        state = "normal";
      }
      continue;
    }

    if (state === "regex") {
      output.push(char);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "[") inRegexClass = true;
      if (char === "]") inRegexClass = false;
      if (char === "/" && !inRegexClass) state = "normal";
      continue;
    }

    if (char === "/" && next === "*") {
      output.push("  ");
      index += 1;
      state = "block-comment";
      continue;
    }
    if (char === "/" && next === "/") {
      output.push(char);
      state = "line-comment";
      continue;
    }
    if (char === "/" && isRegexStart(previousSignificant)) {
      output.push(char);
      state = "regex";
      escaped = false;
      inRegexClass = false;
      previousSignificant = char;
      continue;
    }
    if (char === "'") state = "single";
    if (char === "\"") state = "double";
    if (char === "`") state = "template";
    output.push(char);
    if (!/\s/.test(char)) previousSignificant = char;
  }

  return output.join("");
}


function isRegexStart(previousSignificant: string): boolean {
  return !previousSignificant || "([{=:;,!&|?+-*~%^<>".includes(previousSignificant);
}


export function prepareSyncEsmSource(source: string, importMetaRewriteMode: ImportMetaRewriteMode = "preserve-string-literals"): string {
  return prepareEsmSource(source, importMetaRewriteMode).replace(/\bawait\s+__import\(/g, "__import(");
}


export function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}


export function collectDeclarationExports(source: string): string[] {
  const names = new Set<string>();
  const pattern = /^[ \t]*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)\b/gm;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}


export function collectDefaultDeclarationExport(source: string): string | null {
  const match = source.match(/^[ \t]*export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)\b/m);
  return match?.[1] ?? null;
}


export function hasAnonymousDefaultDeclarationExport(source: string): boolean {
  return /^[ \t]*export\s+default\s+(?:async\s+)?function\s*\(/m.test(source) || /^[ \t]*export\s+default\s+class(?:\s+extends\b|\s*\{)/m.test(source);
}


export function rewriteDefaultAndNamedImport(defaultName: string, named: string, specifier: string): string {
  const temp = `__esm_${defaultName}`;
  return [
    `const ${temp} = await __import("${specifier}");`,
    `const ${defaultName} = ${temp}.default;`,
    `const { ${rewriteNamedImportBindings(named)} } = ${temp};`
  ].join("\n");
}


export function rewriteDefaultAndNamespaceImport(defaultName: string, namespaceName: string, specifier: string): string {
  const temp = `__esm_${defaultName}_${namespaceName}`;
  return [`const ${temp} = await __import("${specifier}");`, `const ${defaultName} = ${temp}.default;`, `const ${namespaceName} = ${temp};`].join("\n");
}


export function rewriteNamedImportBindings(clause: string): string {
  return clause
    .split(",")
    .map((binding) => binding.trim())
    .filter(Boolean)
    .map((binding) => binding.replace(/\s+as\s+/g, ": "))
    .join(", ");
}


export function rewriteNamedExport(clause: string): string {
  return clause
    .split(",")
    .map((binding) => binding.trim())
    .filter(Boolean)
    .map((binding) => {
      const [local, exported] = binding.split(/\s+as\s+/);
      const localName = local?.trim();
      if (!localName) return "";
      return `__exportConst("${(exported || localName).trim()}", ${localName});`;
    })
    .filter(Boolean)
    .join("\n");
}


export function rewriteNamedReExport(clause: string, specifier: string): string {
  const temp = `__reexport_${Math.abs(hashString(`${specifier}:${clause}`))}`;
  return [
    `const ${temp} = await __import("${specifier}");`,
    ...clause
      .split(",")
      .map((binding) => binding.trim())
      .filter(Boolean)
      .map((binding) => {
        const [imported, exported] = binding.split(/\s+as\s+/);
        const importedName = imported?.trim();
        if (!importedName) return "";
        return `__exportConst("${(exported || importedName).trim()}", ${temp}.${importedName});`;
      })
      .filter(Boolean)
  ].join("\n");
}


export function rewriteStarReExport(specifier: string): string {
  const temp = `__reexport_all_${Math.abs(hashString(specifier))}`;
  return [
    `const ${temp} = await __import("${specifier}");`,
    `for (const __key of Object.keys(${temp})) {`,
    `  if (__key !== "default") __exportConst(__key, ${temp}[__key]);`,
    "}"
  ].join("\n");
}


export function rewriteDestructuredConstExport(destructuring: string, expression: string): string {
  const exports = destructuring
    .split(",")
    .map((binding) => binding.trim())
    .filter(Boolean)
    .map((binding) => {
      const [exported, local] = binding.split(":").map((part) => part.trim());
      return {
        exported: exported || "",
        local: local || exported || ""
      };
    })
    .filter(({ exported, local }) => isIdentifier(exported) && isIdentifier(local));
  return [
    `const { ${destructuring} } = ${expression};`,
    ...exports.map(({ exported, local }) => `__exportConst("${exported}", ${local});`)
  ].join("\n");
}


function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}


export function rewriteNamespaceReExport(name: string, specifier: string): string {
  const temp = `__reexport_ns_${Math.abs(hashString(`${name}:${specifier}`))}`;
  return [`const ${temp} = await __import("${specifier}");`, `__exportConst("${name}", ${temp});`].join("\n");
}


function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}
