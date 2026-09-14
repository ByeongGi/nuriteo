export function createBuiltinLoader(bindings) {
  const internalBinding = bindings.internalBinding;
  return function requireBuiltin(specifier) {
    if (specifier === "fs" || specifier === "node:fs") {
      internalBinding?.("fs");
      return bindings.fs;
    }
    throw new Error(`Unsupported builtin module: ${specifier}`);
  };
}
