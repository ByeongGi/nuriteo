import { createBuiltinLoader } from "./builtin-loader.ts";
import { createFsBinding } from "./bindings/fs.ts";
import { createInternalBindingRegistry } from "./internal-binding.ts";
import type { RuntimeFsBinding, RuntimeProgramOptions, RuntimeValue } from "./types.ts";

export interface RuntimeProgramResult {
  result: RuntimeValue;
  exports: RuntimeValue;
}

export function runNodeProgram(source: string, options: RuntimeProgramOptions): RuntimeProgramResult {
  const fsOptions: Parameters<typeof createFsBinding>[1] = {};
  if (options.generation !== undefined) fsOptions.generation = options.generation;
  if (options.pid !== undefined) fsOptions.pid = options.pid;
  if (options.timeoutMs !== undefined) fsOptions.timeoutMs = options.timeoutMs;
  const fs = createFsBinding(options.syncChannel, fsOptions);
  const internalBinding = createInternalBindingRegistry({ fs });
  const require = createBuiltinLoader({ fs, internalBinding });

  if (options.entrypoint === "fs-smoke") {
    return runFsSmokeProgram(require);
  }

  if (source && source.trim()) {
    throw new Error("Dynamic JavaScript evaluation is disabled by the runtime CSP");
  }

  return {
    result: undefined,
    exports: {}
  };
}

function runFsSmokeProgram(require: (specifier: string) => RuntimeValue): RuntimeProgramResult {
  const module = { exports: {} };
  const fs = require("node:fs") as RuntimeFsBinding;
  fs.writeFileSync("/workspace/result.txt", "hello");
  const value = fs.readFileSync("/workspace/result.txt", "utf8");
  module.exports = {
    value,
    size: fs.statSync("/workspace/result.txt").size
  };
  return {
    result: undefined,
    exports: module.exports
  };
}

export function runUnsafeCommonJsForLocalTests(source: string, options: RuntimeProgramOptions): RuntimeProgramResult {
  const fsOptions: Parameters<typeof createFsBinding>[1] = {};
  if (options.generation !== undefined) fsOptions.generation = options.generation;
  if (options.pid !== undefined) fsOptions.pid = options.pid;
  if (options.timeoutMs !== undefined) fsOptions.timeoutMs = options.timeoutMs;
  const fs = createFsBinding(options.syncChannel, fsOptions);
  const internalBinding = createInternalBindingRegistry({ fs });
  const require = createBuiltinLoader({ fs, internalBinding });
  const module = { exports: {} };
  const exports = module.exports;
  const fn = new Function("require", "module", "exports", source);
  const result = fn(require, module, exports);
  return {
    result,
    exports: module.exports
  };
}
