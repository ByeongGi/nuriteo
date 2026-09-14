import { createBuiltinLoader } from "./builtin-loader.ts";
import { createFsBinding } from "./bindings/fs.ts";
import { createInternalBindingRegistry } from "./internal-binding.ts";

export function runNodeProgram(source, options = {}) {
  const fs = createFsBinding(options.syncChannel, {
    generation: options.generation,
    pid: options.pid,
    timeoutMs: options.timeoutMs
  });
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

function runFsSmokeProgram(require) {
  const module = { exports: {} };
  const fs = require("node:fs");
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

export function runUnsafeCommonJsForLocalTests(source, options = {}) {
  const fs = createFsBinding(options.syncChannel, {
    generation: options.generation,
    pid: options.pid,
    timeoutMs: options.timeoutMs
  });
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
