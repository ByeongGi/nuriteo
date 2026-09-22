export interface RunningScriptOptions {
  filename?: string;
  timeout?: number;
  displayErrors?: boolean;
}

export type Context = Record<PropertyKey, unknown>;

const contexts = new WeakSet<object>();

function asContext(value: Context | undefined): Context {
  return value ?? Object.create(null) as Context;
}

function evaluateInContext(code: string, context: Context): unknown {
  const declarations = [...code.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
  const contextualCode = declarations.length > 0
    ? `${code}\n;Object.assign(globalThis, { ${[...new Set(declarations)].join(", ")} });`
    : code;
  const declarationNames = new Set(declarations);
  const scope = new Proxy(context, {
    get(target, property) {
      if (property === Symbol.unscopables) return undefined;
      if (property === "globalThis") return context;
      if (Reflect.has(target, property)) return Reflect.get(target, property);
      return Reflect.get(globalThis, property);
    },
    has(_target, property) {
      return property !== "context"
        && property !== "scope"
        && property !== "source"
        && !(typeof property === "string" && declarationNames.has(property));
    },
    set(target, property, value) {
      return Reflect.set(target, property, value);
    }
  });
  const evaluator = new Function(
    "context",
    "scope",
    "source",
    "return (function (globalThis) { with (scope) { return eval(source); } }).call(context, context);"
  ) as (context: Context, scope: Context, source: string) => unknown;
  return evaluator(context, scope, contextualCode);
}

export function createContext(contextObject: Context = Object.create(null) as Context): Context {
  contexts.add(contextObject);
  return contextObject;
}

export function isContext(value: unknown): boolean {
  return typeof value === "object" && value !== null && contexts.has(value);
}

export function runInNewContext(
  code: string,
  contextObject?: Context,
  _options?: RunningScriptOptions | string
): unknown {
  const context = createContext(asContext(contextObject));
  return evaluateInContext(code, context);
}

export function runInContext(
  code: string,
  contextifiedObject: Context,
  _options?: RunningScriptOptions | string
): unknown {
  if (!isContext(contextifiedObject)) createContext(contextifiedObject);
  return evaluateInContext(code, contextifiedObject);
}

export function runInThisContext(code: string, _options?: RunningScriptOptions | string): unknown {
  return (0, eval)(code);
}

export class Script {
  readonly code: string;

  constructor(code: string, _options?: RunningScriptOptions | string) {
    this.code = code;
  }

  runInContext(contextifiedObject: Context, options?: RunningScriptOptions): unknown {
    return runInContext(this.code, contextifiedObject, options);
  }

  runInNewContext(contextObject?: Context, options?: RunningScriptOptions): unknown {
    return runInNewContext(this.code, contextObject, options);
  }

  runInThisContext(options?: RunningScriptOptions): unknown {
    return runInThisContext(this.code, options);
  }
}

export const vmBuiltin = Object.freeze({
  Script,
  createContext,
  isContext,
  runInContext,
  runInNewContext,
  runInThisContext
});
