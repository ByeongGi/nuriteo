import { EventEmitter } from "./events.ts";
import type { RuntimeValue } from "../types.ts";

export type InspectFunction = ((value: RuntimeValue) => string) & {
  custom: symbol;
};

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

export const inspect: InspectFunction = Object.assign(
  function inspect(value: RuntimeValue): string {
    if (typeof value === "string") return `'${value}'`;
    if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`;
    if (!value || typeof value !== "object") return String(value);
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    const custom = (value as Record<symbol, unknown>)[inspectCustom];
    if (typeof custom === "function") return String(custom.call(value));
    if (Array.isArray(value)) return `[ ${value.map((item) => inspect(item)).join(", ")} ]`;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${inspect(item)}`);
    return `{ ${entries.join(", ")} }`;
  },
  { custom: inspectCustom }
);

export function format(first: RuntimeValue, ...args: RuntimeValue[]): string {
  if (typeof first !== "string") return [first, ...args].map((value) => inspect(value)).join(" ");
  let index = 0;
  const formatted = first.replace(/%[sdifjoO%]/g, (token) => {
    if (token === "%%") return "%";
    const value = args[index++];
    if (token === "%s") return String(value);
    if (token === "%d" || token === "%i") return String(Number.parseInt(String(value), 10));
    if (token === "%f") return String(Number.parseFloat(String(value)));
    if (token === "%j") {
      try {
        return JSON.stringify(value);
      } catch {
        return "[Circular]";
      }
    }
    return inspect(value);
  });
  return [formatted, ...args.slice(index).map((value) => inspect(value))].join(" ");
}

export function formatWithOptions(_options: RuntimeValue, first: RuntimeValue, ...args: RuntimeValue[]): string {
  return format(first, ...args);
}

export function styleText(_format: RuntimeValue, text: RuntimeValue): string {
  return String(text);
}

export function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    let value = rawValue.trim();
    const quote = value[0];
    if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === "\"") {
        value = value
          .replaceAll("\\n", "\n")
          .replaceAll("\\r", "\r")
          .replaceAll("\\t", "\t")
          .replaceAll("\\\"", "\"")
          .replaceAll("\\\\", "\\");
      }
    } else {
      const comment = value.search(/\s+#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    env[key] = value;
  }
  return env;
}

export function inherits(ctor: Function, superCtor: Function): void {
  if (typeof ctor !== "function" || typeof superCtor !== "function") throw new TypeError("ctor and superCtor must be functions");
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  Object.defineProperty(ctor, "super_", {
    configurable: true,
    enumerable: false,
    value: superCtor,
    writable: true
  });
}

export function promisify(fn: (...args: unknown[]) => void): (...args: unknown[]) => Promise<unknown> {
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (error: unknown, value: unknown) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

export function callbackify(fn: (...args: unknown[]) => Promise<unknown>): (...args: unknown[]) => void {
  return (...args) => {
    const callback = args.pop();
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    fn(...args).then(
      (value) => callback(null, value),
      (error) => callback(error)
    );
  };
}

export function deprecate<T extends (...args: unknown[]) => unknown>(fn: T): T {
  return fn;
}

export function debuglog(_section: string): ((...values: unknown[]) => void) & { enabled: boolean } {
  return Object.assign((..._values: unknown[]) => undefined, { enabled: false });
}

export const types = Object.freeze({
  isDate: (value: RuntimeValue): value is Date => value instanceof Date,
  isRegExp: (value: RuntimeValue): value is RegExp => value instanceof RegExp,
  isArrayBuffer: (value: RuntimeValue): value is ArrayBuffer => value instanceof ArrayBuffer,
  isAnyArrayBuffer: (value: RuntimeValue): value is ArrayBuffer | SharedArrayBuffer =>
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer),
  isTypedArray: (value: RuntimeValue): value is ArrayBufferView => ArrayBuffer.isView(value) && !(value instanceof DataView),
  isBoxedPrimitive: (value: RuntimeValue): boolean =>
    /^\[object (?:Boolean|Number|String|Symbol|BigInt)\]$/.test(Object.prototype.toString.call(value)),
  isNativeError: (value: RuntimeValue): value is Error => value instanceof Error,
  isProxy: (_value: RuntimeValue): boolean => false,
  isPromise: (value: RuntimeValue): value is Promise<unknown> => Boolean(value && typeof (value as Promise<unknown>).then === "function")
});

export const utilBuiltin = Object.freeze({
  EventEmitter,
  TextDecoder,
  TextEncoder,
  callbackify,
  debuglog,
  deprecate,
  format,
  formatWithOptions,
  inherits,
  inspect,
  parseEnv,
  promisify,
  styleText,
  types
});
