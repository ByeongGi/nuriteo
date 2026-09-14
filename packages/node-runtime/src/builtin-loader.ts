import type { BuiltinBindings, RuntimeValue } from "./types.ts";

export function createBuiltinLoader(bindings: BuiltinBindings): (specifier: string) => RuntimeValue {
  const internalBinding = bindings.internalBinding;
  return function requireBuiltin(specifier: string): RuntimeValue {
    if (specifier === "fs" || specifier === "node:fs") {
      internalBinding?.("fs");
      return bindings.fs;
    }
    throw new Error(`Unsupported builtin module: ${specifier}`);
  };
}
