import type { EsmRecord } from "./cache.ts";
import type { ModuleRuntime } from "./runtime.ts";
import type { EsmContext, RuntimeNamespace, RuntimeValue } from "../types.ts";

export async function evaluateEsm(runtime: ModuleRuntime, url: string): Promise<RuntimeNamespace> {
  const canonicalUrl = runtime.cache.canonicalize(url);
  const existing = runtime.cache.esm.get(canonicalUrl);
  if (existing?.status === "evaluated") return existing.namespace;
  if (existing?.status === "evaluating") return existing.namespace;

  const definition = runtime.getDefinition(canonicalUrl);
  if (!definition) throw new Error(`ERR_MODULE_NOT_FOUND: ${canonicalUrl}`);
  if (definition.kind !== "esm" && definition.kind !== "esm-source") {
    return cjsNamespace(runtime.requireSync(canonicalUrl, canonicalUrl));
  }

  const bindings = new Map<string, () => RuntimeValue>();
  const namespace: RuntimeNamespace = {};
  const record: EsmRecord = {
    status: "evaluating",
    namespace,
    bindings
  };
  runtime.cache.esm.set(canonicalUrl, record);

  if (definition.kind === "esm") {
    for (const specifier of definition.imports || []) {
      await runtime.importModule(specifier, canonicalUrl);
    }
  }

  const context = {
    url: canonicalUrl,
    importMeta: Object.freeze({
      url: `file://${canonicalUrl}`,
      dirname: canonicalUrl.slice(0, canonicalUrl.lastIndexOf("/")) || "/",
      filename: canonicalUrl,
      resolve: (specifier: string) => runtime.resolveImport(specifier, canonicalUrl)
    }),
    importNamespace: (specifier: string) => runtime.importSync(specifier, canonicalUrl),
    dynamicImport: (specifier: string) => runtime.importModule(specifier, canonicalUrl),
    exportConst: (name: string, value: RuntimeValue) => defineBinding(namespace, bindings, name, () => value),
    exportLive: (name: string, getter: () => RuntimeValue) => defineBinding(namespace, bindings, name, getter)
  };

  if (definition.kind === "esm-source") {
    await compileEsmSource(definition.source, canonicalUrl, runtime.globals)(context);
  } else {
    await definition.factory(context);
  }
  record.status = "evaluated";
  return namespace;
}

export function evaluateEsmSync(runtime: ModuleRuntime, url: string): RuntimeNamespace {
  const canonicalUrl = runtime.cache.canonicalize(url);
  const existing = runtime.cache.esm.get(canonicalUrl);
  if (existing) return existing.namespace;

  const definition = runtime.getDefinition(canonicalUrl);
  if (!definition) throw new Error(`ERR_MODULE_NOT_FOUND: ${canonicalUrl}`);
  if (definition.kind !== "esm" && definition.kind !== "esm-source") {
    return cjsNamespace(runtime.requireSync(canonicalUrl, canonicalUrl));
  }

  const bindings = new Map<string, () => RuntimeValue>();
  const namespace: RuntimeNamespace = {};
  const record: EsmRecord = {
    status: "evaluating",
    namespace,
    bindings
  };
  runtime.cache.esm.set(canonicalUrl, record);

  if (definition.kind === "esm") {
    for (const specifier of definition.imports || []) {
      runtime.importSync(specifier, canonicalUrl);
    }
  }

  const context = {
    url: canonicalUrl,
    importMeta: Object.freeze({
      url: `file://${canonicalUrl}`,
      dirname: canonicalUrl.slice(0, canonicalUrl.lastIndexOf("/")) || "/",
      filename: canonicalUrl,
      resolve: (specifier: string) => runtime.resolveImport(specifier, canonicalUrl)
    }),
    importNamespace: (specifier: string) => runtime.importSync(specifier, canonicalUrl),
    dynamicImport: (specifier: string) => Promise.resolve(runtime.importSync(specifier, canonicalUrl)),
    exportConst: (name: string, value: RuntimeValue) => defineBinding(namespace, bindings, name, () => value),
    exportLive: (name: string, getter: () => RuntimeValue) => defineBinding(namespace, bindings, name, getter)
  };

  if (definition.kind === "esm-source") {
    compileEsmSourceSync(definition.source, canonicalUrl, runtime.globals)(context);
  } else {
    const result = definition.factory(context);
    if (isPromiseLike(result)) throw new Error(`ERR_REQUIRE_ASYNC_MODULE: ${canonicalUrl}`);
  }
  record.status = "evaluated";
  return namespace;
}

function defineBinding(namespace: RuntimeNamespace, bindings: Map<string, () => RuntimeValue>, name: string, getter: () => RuntimeValue): void {
  bindings.set(name, getter);
  if (!Object.prototype.hasOwnProperty.call(namespace, name)) {
    Object.defineProperty(namespace, name, {
      enumerable: true,
      get: () => bindings.get(name)?.()
    });
  }
}

export function cjsNamespace(exports: RuntimeValue): RuntimeNamespace {
  const namespace: RuntimeNamespace = {};
  Object.defineProperty(namespace, "default", {
    enumerable: true,
    value: exports
  });
  if ((typeof exports === "object" || typeof exports === "function") && exports) {
    for (const key of Object.keys(exports)) {
      if (key === "default") continue;
      Object.defineProperty(namespace, key, {
        enumerable: true,
        value: (exports as Record<string, unknown>)[key]
      });
    }
  }
  return namespace;
}

function compileEsmSource(source: string, filename: string, globals: Record<string, RuntimeValue>): (context: EsmContext) => Promise<void> {
  return createEsmSourceCompiler({
    filename,
    globals,
    originalSource: source,
    preparedSource: prepareEsmSource(source, importMetaRewriteModeFor(filename))
  });
}

function compileEsmSourceSync(source: string, filename: string, globals: Record<string, RuntimeValue>): (context: EsmContext) => void {
  return createSyncEsmSourceCompiler(prepareSyncEsmSource(source, importMetaRewriteModeFor(filename)), filename, globals);
}

function createEsmSourceCompiler(options: {
  filename: string;
  globals: Record<string, RuntimeValue>;
  originalSource: string;
  preparedSource: string;
}): (context: EsmContext) => Promise<void> {
  const { filename, globals, originalSource, preparedSource } = options;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (context: {
    dynamicImport: (specifier: string) => Promise<RuntimeNamespace>;
    exportConst: (name: string, value: RuntimeValue) => void;
    exportLive: (name: string, getter: () => RuntimeValue) => void;
  }, process: RuntimeValue, global: RuntimeValue, console: RuntimeValue, globalThis: RuntimeValue) => Promise<void>;
  let compiled: (context: {
    dynamicImport: (specifier: string) => Promise<RuntimeNamespace>;
    exportConst: (name: string, value: RuntimeValue) => void;
    exportLive: (name: string, getter: () => RuntimeValue) => void;
  }, process: RuntimeValue, global: RuntimeValue, console: RuntimeValue, globalThis: RuntimeValue) => Promise<void>;
  try {
    compiled = new AsyncFunction(
      "__context",
      "__process",
      "__global",
      "__console",
      "__globalThis",
      `${prepareEsmRuntimeGlobals(preparedSource)}\n//# sourceURL=${filename}`
    ) as typeof compiled;
  } catch (error) {
    if (!isDynamicCodeBlocked(error)) {
      if (error instanceof SyntaxError && error.message.includes("import.meta")) {
        const fallbackIndex = preparedSource.search(/import[\s\S]{0,32}meta/);
        const line = fallbackIndex >= 0 ? preparedSource.slice(0, fallbackIndex).split("\n").length : null;
        const snippet = fallbackIndex >= 0 ? preparedSource.slice(Math.max(0, fallbackIndex - 80), fallbackIndex + 160).replace(/\s+/g, " ").trim() : null;
        throw new SyntaxError(`${error.message} while compiling ${filename}${line ? ` near transformed line ${line}` : ""}${snippet ? `: ${snippet}` : ""}`);
      }
      throw error;
    }
    const evalFreeCompiler = compileEvalFreeEsmSource(originalSource, globals);
    if (evalFreeCompiler) return evalFreeCompiler;
    throw new Error(`ECLICSPUNSUPPORTED: browser worker CSP blocks dynamic ESM evaluation for this module: ${filename}`);
  }
  return (context) => compiled(context, globals.process, globals.global, globals.console ?? console, globals.globalThis ?? globals.global);
}

function createSyncEsmSourceCompiler(source: string, filename: string, globals: Record<string, RuntimeValue>): (context: EsmContext) => void {
  let compiled: (context: EsmContext, process: RuntimeValue, global: RuntimeValue, console: RuntimeValue, globalThis: RuntimeValue) => void;
  try {
    compiled = new Function(
      "__context",
      "__process",
      "__global",
      "__console",
      "__globalThis",
      `${prepareEsmRuntimeGlobals(source, "importNamespace")}\n//# sourceURL=${filename}`
    ) as (context: EsmContext, process: RuntimeValue, global: RuntimeValue, console: RuntimeValue, globalThis: RuntimeValue) => void;
  } catch (error) {
    if (error instanceof SyntaxError && /await is only valid|Unexpected reserved word/i.test(error.message)) {
      throw new Error(`ERR_REQUIRE_ASYNC_MODULE: ${filename}`);
    }
    throw error;
  }
  return (context) => compiled(context, globals.process, globals.global, globals.console ?? console, globals.globalThis ?? globals.global);
}

function prepareEsmRuntimeGlobals(source: string, importHook: "dynamicImport" | "importNamespace" = "dynamicImport"): string {
  const injections = [
    `const __import = __context.${importHook};`,
    "const __exportConst = __context.exportConst;",
    "const __exportLive = __context.exportLive;"
  ];
  if (!declaresLexicalBinding(source, "process")) injections.push("const process = __process;");
  if (!declaresLexicalBinding(source, "global")) injections.push("const global = __global;");
  if (!declaresLexicalBinding(source, "globalThis")) injections.push("const globalThis = __globalThis;");
  if (!declaresLexicalBinding(source, "console")) injections.push("const console = __console;");
  if (!declaresLexicalBinding(source, "Buffer")) injections.push("const Buffer = __global?.Buffer ?? __globalThis?.Buffer;");
  if (!declaresLexicalBinding(source, "setTimeout")) injections.push("const setTimeout = __global?.setTimeout ?? __globalThis?.setTimeout;");
  if (!declaresLexicalBinding(source, "clearTimeout")) injections.push("const clearTimeout = __global?.clearTimeout ?? __globalThis?.clearTimeout;");
  if (!declaresLexicalBinding(source, "setInterval")) injections.push("const setInterval = __global?.setInterval ?? __globalThis?.setInterval;");
  if (!declaresLexicalBinding(source, "clearInterval")) injections.push("const clearInterval = __global?.clearInterval ?? __globalThis?.clearInterval;");
  if (!declaresLexicalBinding(source, "setImmediate")) injections.push("const setImmediate = __global?.setImmediate ?? __globalThis?.setImmediate;");
  if (!declaresLexicalBinding(source, "clearImmediate")) injections.push("const clearImmediate = __global?.clearImmediate ?? __globalThis?.clearImmediate;");
  return `${injections.join("\n")}\n${source}`;
}

function compileEvalFreeEsmSource(source: string, globals: Record<string, RuntimeValue>): ((context: EsmContext) => Promise<void>) | null {
  const sourceWithoutShebang = stripShebang(source);
  const importRecords = collectEvalFreeImports(sourceWithoutShebang);
  const functions = collectEvalFreeFunctions(sourceWithoutShebang);
  const topLevel = removeEvalFreeImports(removeEvalFreeFunctionBlocks(sourceWithoutShebang, functions));
  if (importRecords.length === 0 && functions.length === 0 && !containsEvalFreeExecutableStatement(topLevel)) return null;

  return async (context) => {
    const scope = new Map<string, RuntimeValue>();
    const loadedSpecifiers = new Set<string>();
    for (const record of importRecords) {
      if (record.kind === "side-effect") {
        if (!loadedSpecifiers.has(record.specifier)) {
          await context.dynamicImport(record.specifier);
          loadedSpecifiers.add(record.specifier);
        }
        continue;
      }
      const namespace = await context.dynamicImport(record.specifier);
      loadedSpecifiers.add(record.specifier);
      for (const binding of record.bindings) {
        scope.set(binding.local, namespace[binding.imported]);
      }
    }
    for (const fn of functions) {
      const callable = (...args: RuntimeValue[]) => executeEvalFreeFunction(fn, args, scope, globals, context);
      scope.set(fn.name, callable);
      if (fn.exported) context.exportConst(fn.name, callable);
    }
    await executeEvalFreeStatements(topLevel, scope, globals, context);
  };
}

interface EvalFreeImportRecord {
  bindings: { imported: string; local: string }[];
  kind: "default" | "named" | "side-effect";
  specifier: string;
}

interface EvalFreeFunctionRecord {
  body: string;
  end: number;
  exported: boolean;
  name: string;
  params: string[];
  start: number;
}

function collectEvalFreeImports(source: string): EvalFreeImportRecord[] {
  const records: EvalFreeImportRecord[] = [];
  for (const match of source.matchAll(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm)) {
    if (!match[1] || !match[2]) continue;
    records.push({
      bindings: [{ imported: "default", local: match[1] }],
      kind: "default",
      specifier: match[2]
    });
  }
  for (const match of source.matchAll(/^[ \t]*import\s+\{([^}\n]+)\}\s+from\s+["']([^"']+)["'];?[ \t]*$/gm)) {
    const clause = match[1];
    const specifier = match[2];
    if (!clause || !specifier) continue;
    records.push({
      bindings: clause
        .split(",")
        .map((binding) => binding.trim())
        .filter(Boolean)
        .map((binding) => {
          const [imported, local] = binding.split(/\s+as\s+/);
          const importedName = imported?.trim() || "";
          return { imported: importedName, local: local?.trim() || importedName };
        })
        .filter((binding) => binding.imported.length > 0 && binding.local.length > 0),
      kind: "named",
      specifier
    });
  }
  for (const match of source.matchAll(/^[ \t]*import\s+["']([^"']+)["'];?[ \t]*$/gm)) {
    if (!match[1]) continue;
    records.push({ bindings: [], kind: "side-effect", specifier: match[1] });
  }
  return records;
}

function removeEvalFreeImports(source: string): string {
  return source
    .replace(/^[ \t]*import\s+[A-Za-z_$][\w$]*\s+from\s+["'][^"']+["'];?[ \t]*$/gm, "")
    .replace(/^[ \t]*import\s+\{[^}\n]+\}\s+from\s+["'][^"']+["'];?[ \t]*$/gm, "")
    .replace(/^[ \t]*import\s+["'][^"']+["'];?[ \t]*$/gm, "");
}

function collectEvalFreeFunctions(source: string): EvalFreeFunctionRecord[] {
  const records: EvalFreeFunctionRecord[] = [];
  const pattern = /(export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const name = match[2];
    if (!name) continue;
    const bodyStart = pattern.lastIndex;
    const bodyEnd = findMatchingBrace(source, bodyStart - 1);
    if (bodyEnd < 0) continue;
    records.push({
      body: source.slice(bodyStart, bodyEnd),
      end: bodyEnd + 1,
      exported: Boolean(match[1]),
      name,
      params: (match[3] || "").split(",").map((param) => param.trim()).filter(Boolean),
      start: match.index
    });
    pattern.lastIndex = bodyEnd + 1;
  }
  return records;
}

function removeEvalFreeFunctionBlocks(source: string, functions: readonly EvalFreeFunctionRecord[]): string {
  let output = "";
  let cursor = 0;
  for (const fn of functions) {
    output += source.slice(cursor, fn.start);
    cursor = fn.end;
  }
  return output + source.slice(cursor);
}

function containsEvalFreeExecutableStatement(source: string): boolean {
  return /(?:^|[;\n])\s*(?:if\s*\(|[A-Za-z_$][\w$]*\s*\(|global(?:This)?\.__[A-Za-z_$][\w$]*\?\.\()/.test(source);
}

async function executeEvalFreeFunction(
  fn: EvalFreeFunctionRecord,
  args: RuntimeValue[],
  parentScope: Map<string, RuntimeValue>,
  globals: Record<string, RuntimeValue>,
  context: EsmContext
): Promise<RuntimeValue> {
  const scope = new Map(parentScope);
  fn.params.forEach((param, index) => scope.set(param, args[index]));
  return executeEvalFreeStatements(fn.body, scope, globals, context);
}

async function executeEvalFreeStatements(
  source: string,
  scope: Map<string, RuntimeValue>,
  globals: Record<string, RuntimeValue>,
  context: EsmContext
): Promise<RuntimeValue> {
  let remaining = source;
  const conditional = extractProcessArgvConditional(remaining);
  if (conditional) {
    const process = globals.process as { argv?: string[] } | undefined;
    const selected = process?.argv?.includes(conditional.argument) ? conditional.whenTrue : conditional.whenFalse;
    await executeEvalFreeStatements(selected, scope, globals, context);
    remaining = `${remaining.slice(0, conditional.start)}\n${remaining.slice(conditional.end)}`;
  }

  for (const assignment of collectGlobalAssignments(remaining)) {
    setEvalFreeGlobalValue(globals, assignment.name, evaluateEvalFreeExpression(assignment.expression, scope, globals, context));
  }

  for (const declaration of collectEvalFreeDeclarations(remaining)) {
    scope.set(declaration.name, evaluateEvalFreeExpression(declaration.expression, scope, globals, context));
  }

  for (const call of collectGlobalHookCalls(remaining)) {
    const handler = getEvalFreeGlobalValue(globals, call.name);
    if (typeof handler === "function") {
      (handler as (...args: RuntimeValue[]) => RuntimeValue)(evaluateEvalFreeObjectLiteral(call.argument, scope, globals));
    }
  }

  for (const call of collectEvalFreeFunctionCalls(remaining)) {
    const callable = scope.get(call.name);
    if (typeof callable !== "function") continue;
    await (callable as (...args: RuntimeValue[]) => RuntimeValue | Promise<RuntimeValue>)(...call.args.map((arg) => evaluateEvalFreeExpression(arg, scope, globals, context)));
  }


  for (const clause of remaining.matchAll(/^[ \t]*export\s+\{([^}\n]+)\};?[ \t]*$/gm)) {
    for (const binding of (clause[1] || "").split(",")) {
      const [local, exported] = binding.trim().split(/\s+as\s+/);
      if (local) context.exportConst(exported || local, scope.get(local));
    }
  }
  const defaultExport = remaining.match(/^[ \t]*export\s+default\s+([^;\n]+);?[ \t]*$/m);
  if (defaultExport?.[1]) context.exportConst("default", evaluateEvalFreeExpression(defaultExport[1], scope, globals, context));

  const returnExpression = remaining.match(/\breturn\s+([^;\n]+);?/);
  return returnExpression?.[1] ? evaluateEvalFreeExpression(returnExpression[1], scope, globals, context) : undefined;
}

function collectEvalFreeDeclarations(source: string): { expression: string; name: string }[] {
  return [...source.matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);[ \t]*$/gm)]
    .map((match) => ({ name: match[1] || "", expression: match[2] || "" }))
    .filter((declaration) => declaration.name.length > 0);
}

function extractProcessArgvConditional(source: string): { argument: string; end: number; start: number; whenFalse: string; whenTrue: string } | null {
  const match = /if\s*\(\s*process\.argv\.includes\(\s*["']([^"']+)["']\s*\)\s*\)\s*\{/.exec(source);
  if (!match?.[1]) return null;
  const trueOpen = (match.index ?? 0) + match[0].length - 1;
  const trueClose = findMatchingBrace(source, trueOpen);
  if (trueClose < 0) return null;
  const elseMatch = /^\s*else\s*\{/.exec(source.slice(trueClose + 1));
  if (!elseMatch) return null;
  const falseOpen = trueClose + 1 + elseMatch[0].length - 1;
  const falseClose = findMatchingBrace(source, falseOpen);
  if (falseClose < 0) return null;
  return {
    argument: match[1],
    end: falseClose + 1,
    start: match.index,
    whenFalse: source.slice(falseOpen + 1, falseClose),
    whenTrue: source.slice(trueOpen + 1, trueClose)
  };
}

function collectGlobalHookCalls(source: string): { argument: string; name: string }[] {
  const calls: { argument: string; name: string }[] = [];
  const pattern = /global(?:This)?\.(__(?:[A-Za-z_$][\w$]*))\?\.\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const name = match[1];
    const open = pattern.lastIndex - 1;
    const close = findMatchingBrace(source, open);
    if (!name || close < 0) continue;
    calls.push({ argument: source.slice(open, close + 1), name });
    pattern.lastIndex = close + 1;
  }
  return calls;
}

function collectGlobalAssignments(source: string): { expression: string; name: string }[] {
  return [...source.matchAll(/global(?:This)?\.(__(?:[A-Za-z_$][\w$]*))\s*=\s*([^;\n]+);?/g)]
    .map((match) => ({
      expression: match[2] || "",
      name: match[1] || ""
    }))
    .filter((assignment) => assignment.name.length > 0 && assignment.expression.length > 0);
}

function getEvalFreeGlobalValue(globals: Record<string, RuntimeValue>, name: string): RuntimeValue {
  const globalObject = globals.global;
  const globalThisObject = globals.globalThis;
  if (typeof globalObject === "object" && globalObject !== null && name in globalObject) {
    return (globalObject as Record<string, RuntimeValue>)[name];
  }
  if (typeof globalThisObject === "object" && globalThisObject !== null && name in globalThisObject) {
    return (globalThisObject as Record<string, RuntimeValue>)[name];
  }
  return globals[name];
}

function setEvalFreeGlobalValue(globals: Record<string, RuntimeValue>, name: string, value: RuntimeValue): void {
  const globalObject = globals.global;
  const globalThisObject = globals.globalThis;
  if (typeof globalObject === "object" && globalObject !== null) {
    (globalObject as Record<string, RuntimeValue>)[name] = value;
  }
  if (typeof globalThisObject === "object" && globalThisObject !== null) {
    (globalThisObject as Record<string, RuntimeValue>)[name] = value;
  }
  globals[name] = value;
}

function collectEvalFreeFunctionCalls(source: string): { args: string[]; name: string }[] {
  const calls: { args: string[]; name: string }[] = [];
  const pattern = /(?:^|[;\n])\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const name = match[1];
    if (!name || name === "if" || name === "return") continue;
    const open = pattern.lastIndex - 1;
    const close = findMatchingParen(source, open);
    if (close < 0) continue;
    calls.push({ args: splitTopLevelComma(source.slice(open + 1, close)), name });
    pattern.lastIndex = close + 1;
  }
  return calls;
}

function evaluateEvalFreeObjectLiteral(source: string, scope: Map<string, RuntimeValue>, globals: Record<string, RuntimeValue>): Record<string, RuntimeValue> {
  const inner = source.trim().replace(/^\{/, "").replace(/\}$/, "");
  const result: Record<string, RuntimeValue> = {};
  for (const property of splitTopLevelComma(inner)) {
    const method = property.match(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
    if (method?.[1]) {
      result[method[1]] = () => undefined;
      continue;
    }
    const separator = property.indexOf(":");
    if (separator < 0) continue;
    const key = property.slice(0, separator).trim().replace(/^["']|["']$/g, "");
    if (!key) continue;
    result[key] = evaluateEvalFreeExpression(property.slice(separator + 1).trim(), scope, globals);
  }
  return result;
}

function evaluateEvalFreeExpression(source: string, scope: Map<string, RuntimeValue>, globals: Record<string, RuntimeValue>, context?: EsmContext): RuntimeValue {
  const expression = source.trim();
  const stringMatch = expression.match(/^(["'`])([\s\S]*)\1$/);
  if (stringMatch) return unescapeJsString(stringMatch[2] || "");
  if (/^-?\d+(?:\.\d+)?$/.test(expression)) return Number(expression);
  if (expression === "true") return true;
  if (expression === "false") return false;
  if (expression === "undefined") return undefined;
  if (expression.startsWith("[") && expression.endsWith("]")) {
    return splitTopLevelComma(expression.slice(1, -1)).map((item) => evaluateEvalFreeExpression(item, scope, globals, context));
  }
  if (expression.startsWith("{") && expression.endsWith("}")) return evaluateEvalFreeObjectLiteral(expression, scope, globals);
  const dynamicImportMatch = expression.match(/^import\(\s*(["'])([^"']+)\1\s*\)(?:\.then\([^)]*\))?$/);
  if (dynamicImportMatch?.[2] && context) return context.dynamicImport(dynamicImportMatch[2]);
  const numberEnvMatch = expression.match(/^Number\(\s*process\.env\.([A-Za-z_$][\w$]*)\s*\|\|\s*(\d+)\s*\)$/);
  if (numberEnvMatch?.[1] && numberEnvMatch[2]) {
    const process = globals.process as { env?: Record<string, string | undefined> } | undefined;
    return Number(process?.env?.[numberEnvMatch[1]] || numberEnvMatch[2]);
  }
  const callMatch = expression.match(/^([A-Za-z_$][\w$]*)\((.*)\)$/);
  if (callMatch?.[1]) {
    const callable = scope.get(callMatch[1]);
    if (typeof callable === "function") {
      return (callable as (...args: RuntimeValue[]) => RuntimeValue)(...splitTopLevelComma(callMatch[2] || "").map((arg) => evaluateEvalFreeExpression(arg, scope, globals, context)));
    }
  }
  const memberCallMatch = expression.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\((.*)\)$/);
  if (memberCallMatch?.[1] && memberCallMatch[2]) {
    const target = scope.get(memberCallMatch[1]);
    if (typeof target === "object" && target !== null) {
      const method = (target as Record<string, RuntimeValue>)[memberCallMatch[2]];
      if (typeof method === "function") {
        return (method as (...args: RuntimeValue[]) => RuntimeValue).call(target, ...splitTopLevelComma(memberCallMatch[3] || "").map((arg) => evaluateEvalFreeExpression(arg, scope, globals, context)));
      }
    }
  }
  const memberMatch = expression.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
  if (memberMatch?.[1] && memberMatch[2]) {
    const target = scope.get(memberMatch[1]);
    if (typeof target === "object" && target !== null) return (target as Record<string, RuntimeValue>)[memberMatch[2]];
  }
  if (scope.has(expression)) return scope.get(expression);
  return undefined;
}

function findMatchingBrace(source: string, openIndex: number): number {
  return findMatchingDelimiter(source, openIndex, "{", "}");
}

function findMatchingParen(source: string, openIndex: number): number {
  return findMatchingDelimiter(source, openIndex, "(", ")");
}

function findMatchingDelimiter(source: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let state: "normal" | "single" | "double" | "template" = "normal";
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index] || "";
    if (state !== "normal") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if ((state === "single" && char === "'") || (state === "double" && char === "\"") || (state === "template" && char === "`")) {
        state = "normal";
      }
      continue;
    }
    if (char === "'") {
      state = "single";
      continue;
    }
    if (char === "\"") {
      state = "double";
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevelComma(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let state: "normal" | "single" | "double" | "template" = "normal";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] || "";
    if (state !== "normal") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if ((state === "single" && char === "'") || (state === "double" && char === "\"") || (state === "template" && char === "`")) state = "normal";
      continue;
    }
    if (char === "'") state = "single";
    else if (char === "\"") state = "double";
    else if (char === "`") state = "template";
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "," && braceDepth === 0 && parenDepth === 0) {
      const part = source.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const last = source.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function isDynamicCodeBlocked(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /unsafe-eval|Content Security Policy|Code generation from strings|call to eval/i.test(error.message);
}

function stripShebang(source: string): string {
  return source.startsWith("#!") ? `//${source.slice(2)}` : source;
}

function unescapeJsString(value: string): string {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll("\\\\", "\\")
    .replaceAll("\\'", "'")
    .replaceAll('\\"', '"');
}

function declaresLexicalBinding(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|[\\n;])\\s*(?:const|let|var|class|function)\\s+${escaped}(?![$\\w])`).test(source)) return true;
  for (const match of source.matchAll(/(?:^|[\n;])\s*(?:const|let|var)\s*\{([^}]*)\}/g)) {
    const bindings = match[1] || "";
    if (new RegExp(`(?:^|,)\\s*${escaped}\\s*(?:=|,|$)`).test(bindings)) return true;
    if (new RegExp(`(?:^|,)\\s*[$\\w]+\\s*:\\s*${escaped}\\s*(?:=|,|$)`).test(bindings)) return true;
  }
  if (new RegExp(`(?:^|\\n)\\s*import\\s+(?:type\\s+)?${escaped}(?:\\s*,|\\s+from\\b)`).test(source)) return true;
  if (new RegExp(`(?:^|\\n)\\s*import\\s+\\*\\s+as\\s+${escaped}\\s+from\\b`).test(source)) return true;
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\b/g)) {
    const bindings = match[1] || "";
    if (new RegExp(`(?:^|,)\\s*${escaped}\\s*(?:,|$)`).test(bindings)) return true;
    if (new RegExp(`\\bas\\s+${escaped}\\s*(?:,|$)`).test(bindings)) return true;
  }
  return false;
}

type ImportMetaRewriteMode = "preserve-string-literals" | "vite-bundle";

function importMetaRewriteModeFor(filename: string): ImportMetaRewriteMode {
  return filename.includes("/node_modules/vite/") || filename.includes("/node_modules/rolldown/")
    ? "vite-bundle"
    : "preserve-string-literals";
}

function prepareEsmSource(source: string, importMetaRewriteMode: ImportMetaRewriteMode = "preserve-string-literals"): string {
  const literalProtection = protectImportExportLinesInsideLiterals(stripBlockComments(source));
  const sourceWithoutBlockComments = literalProtection.source;
  const declarationExports = collectDeclarationExports(sourceWithoutBlockComments);
  const defaultDeclarationExport = collectDefaultDeclarationExport(sourceWithoutBlockComments) ?? (hasAnonymousDefaultDeclarationExport(sourceWithoutBlockComments) ? "__default_export__" : null);
  const prepared = sourceWithoutBlockComments
    .replace(/^#!.*(?:\n|$)/, "")
    .replace(/^[ \t]*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, "const $1 = await __import(\"$2\");")
    .replace(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s*,\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_match, defaultName: string, namespaceName: string, specifier: string) => {
      return rewriteDefaultAndNamespaceImport(defaultName, namespaceName, specifier);
    })
    .replace(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_match, defaultName: string, named: string, specifier: string) => {
      return rewriteDefaultAndNamedImport(defaultName, named, specifier);
    })
    .replace(/^[ \t]*import\s+\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_match, named: string, specifier: string) => {
      return `const { ${rewriteNamedImportBindings(named)} } = await __import("${specifier}");`;
    })
    .replace(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, "const $1 = (await __import(\"$2\")).default;")
    .replace(/^[ \t]*import\s+["']([^"']+)["'];?[ \t]*$/gm, "await __import(\"$1\");")
    .replace(/(?<![.$\w])import\s*\(/g, "__import(")
    .replace(/^[ \t]*export\s+const\s+\{([^}]+)\}\s*=\s*([^;\n]+);?[ \t]*$/gm, (_match, destructuring: string, expression: string) => {
      return rewriteDestructuredConstExport(destructuring, expression);
    })
    .replace(/^[ \t]*export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);?[ \t]*$/gm, "const $1 = $2;\n__exportConst(\"$1\", $1);")
    .replace(/^[ \t]*export\s+(let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);?[ \t]*$/gm, "$1 $2 = $3;\n__exportLive(\"$2\", () => $2);")
    .replace(/^[ \t]*export\s+default\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm, "async function $1(")
    .replace(/^[ \t]*export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm, "function $1(")
    .replace(/^[ \t]*export\s+default\s+class\s+([A-Za-z_$][\w$]*)\b/gm, "class $1")
    .replace(/^[ \t]*export\s+default\s+async\s+function\s*\(/gm, "const __default_export__ = async function (")
    .replace(/^[ \t]*export\s+default\s+function\s*\(/gm, "const __default_export__ = function (")
    .replace(/^[ \t]*export\s+default\s+class\b/gm, "const __default_export__ = class")
    .replace(/^[ \t]*export\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm, "async function $1(")
    .replace(/^[ \t]*export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm, "function $1(")
    .replace(/^[ \t]*export\s+class\s+([A-Za-z_$][\w$]*)\b/gm, "class $1")
    .replace(/^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*\([\s\S]*?\n[ \t]*(?:[\}\]]\)|\)));?[ \t]*$/gm, "const __default_export__ = $1;\n__exportConst(\"default\", __default_export__);")
    .replace(/^[ \t]*export\s+default\s+([^;\n]+);?[ \t]*$/gm, "__exportConst(\"default\", $1);")
    .replace(/^[ \t]*export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_match, name: string, specifier: string) => {
      return rewriteNamespaceReExport(name, specifier);
    })
    .replace(/^[ \t]*export\s+\*\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_match, specifier: string) => {
      return rewriteStarReExport(specifier);
    })
    .replace(/^[ \t]*export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_match, clause: string, specifier: string) => {
      return rewriteNamedReExport(clause, specifier);
    })
    .replace(/^[ \t]*export\s+\{([^}]+)\};?[ \t]*$/gm, (_match, clause: string) => {
      return rewriteNamedExport(clause);
    })
    .replace(/^[ \t]*export\s+\{\s*\};?[ \t]*$/gm, "");
  const postExports = [
    ...declarationExports.map((name) => `__exportConst("${name}", ${name});`),
    ...(defaultDeclarationExport ? [`__exportConst("default", ${defaultDeclarationExport});`] : [])
  ];
  const output = postExports.length > 0
    ? `${prepared}\n${postExports.join("\n")}`
    : prepared;
  return rewriteImportMetaReferences(literalProtection.restore(output), importMetaRewriteMode);
}

/**
 * Build-time companion for the CSP-safe module registry. The returned source
 * is JavaScript that can be embedded in a same-origin static factory; runtime
 * code must never pass it to eval or Function.
 */
export function prepareEsmSourceForStaticFactory(source: string, filename: string): string {
  return prepareEsmSource(source, importMetaRewriteModeFor(filename));
}

export function prepareEsmStaticFactoryBody(source: string, filename: string): string {
  return prepareEsmRuntimeGlobals(prepareEsmSource(source, importMetaRewriteModeFor(filename)));
}

function rewriteImportMetaReferences(source: string, mode: ImportMetaRewriteMode): string {
  const rewritten = source.replace(/\bimport\.meta\b/g, "__context.importMeta");
  if (mode === "vite-bundle") return restoreViteImportMetaAnalysisSentinels(rewritten);
  return restoreImportMetaInStringLiterals(rewritten);
}

function restoreViteImportMetaAnalysisSentinels(source: string): string {
  // Vite treats import.meta expressions as source text in define keys, filters,
  // generated client modules, and diagnostics. Those string literals must keep
  // their original spelling; only executable references belong to the runtime
  // context used by the static factory.
  return restoreImportMetaInStringLiterals(source);
}

function restoreImportMetaInStringLiterals(source: string): string {
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

function protectImportExportLinesInsideLiterals(source: string): { restore: (value: string) => string; source: string } {
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

function stripBlockComments(source: string): string {
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

function prepareSyncEsmSource(source: string, importMetaRewriteMode: ImportMetaRewriteMode = "preserve-string-literals"): string {
  return prepareEsmSource(source, importMetaRewriteMode).replace(/\bawait\s+__import\(/g, "__import(");
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function collectDeclarationExports(source: string): string[] {
  const names = new Set<string>();
  const pattern = /^[ \t]*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)\b/gm;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function collectDefaultDeclarationExport(source: string): string | null {
  const match = source.match(/^[ \t]*export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)\b/m);
  return match?.[1] ?? null;
}

function hasAnonymousDefaultDeclarationExport(source: string): boolean {
  return /^[ \t]*export\s+default\s+(?:async\s+)?function\s*\(/m.test(source) || /^[ \t]*export\s+default\s+class(?:\s+extends\b|\s*\{)/m.test(source);
}

function rewriteDefaultAndNamedImport(defaultName: string, named: string, specifier: string): string {
  const temp = `__esm_${defaultName}`;
  return [
    `const ${temp} = await __import("${specifier}");`,
    `const ${defaultName} = ${temp}.default;`,
    `const { ${rewriteNamedImportBindings(named)} } = ${temp};`
  ].join("\n");
}

function rewriteDefaultAndNamespaceImport(defaultName: string, namespaceName: string, specifier: string): string {
  const temp = `__esm_${defaultName}_${namespaceName}`;
  return [`const ${temp} = await __import("${specifier}");`, `const ${defaultName} = ${temp}.default;`, `const ${namespaceName} = ${temp};`].join("\n");
}

function rewriteNamedImportBindings(clause: string): string {
  return clause
    .split(",")
    .map((binding) => binding.trim())
    .filter(Boolean)
    .map((binding) => binding.replace(/\s+as\s+/g, ": "))
    .join(", ");
}

function rewriteNamedExport(clause: string): string {
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

function rewriteNamedReExport(clause: string, specifier: string): string {
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

function rewriteStarReExport(specifier: string): string {
  const temp = `__reexport_all_${Math.abs(hashString(specifier))}`;
  return [
    `const ${temp} = await __import("${specifier}");`,
    `for (const __key of Object.keys(${temp})) {`,
    `  if (__key !== "default") __exportConst(__key, ${temp}[__key]);`,
    "}"
  ].join("\n");
}

function rewriteDestructuredConstExport(destructuring: string, expression: string): string {
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

function rewriteNamespaceReExport(name: string, specifier: string): string {
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
