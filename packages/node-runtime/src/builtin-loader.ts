import type { BuiltinBindings, RuntimeValue } from "./types.ts";
import { bufferBuiltin } from "./builtins/buffer.ts";
import { eventsBuiltin } from "./builtins/events.ts";
import { streamBuiltin, streamPromisesBuiltin } from "./builtins/stream.ts";
import { utilBuiltin } from "./builtins/util.ts";

export function createBuiltinLoader(bindings: BuiltinBindings): (specifier: string) => RuntimeValue {
  const internalBinding = bindings.internalBinding;
  return function requireBuiltin(specifier: string): RuntimeValue {
    if (specifier === "fs" || specifier === "node:fs") {
      internalBinding?.("fs");
      return bindings.fs;
    }
    if (specifier === "buffer" || specifier === "node:buffer") return bindings.buffer || bufferBuiltin;
    if (specifier === "events" || specifier === "node:events") return bindings.events || eventsBuiltin;
    if (specifier === "stream" || specifier === "node:stream") return bindings.stream || streamBuiltin;
    if (specifier === "stream/promises" || specifier === "node:stream/promises") return streamPromisesBuiltin;
    if (specifier === "util" || specifier === "node:util") return bindings.util || utilBuiltin;
    throw new Error(`Unsupported builtin module: ${specifier}`);
  };
}
