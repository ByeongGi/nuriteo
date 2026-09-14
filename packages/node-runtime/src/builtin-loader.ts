import type { BuiltinBindings, RuntimeValue } from "./types.ts";
import { assertBuiltin, strict as assertStrictBuiltin } from "./builtins/assert.ts";
import { bufferBuiltin } from "./builtins/buffer.ts";
import { eventsBuiltin } from "./builtins/events.ts";
import { osBuiltin } from "./builtins/os.ts";
import { pathBuiltin } from "./builtins/path.ts";
import { BrowserProcess } from "./builtins/process.ts";
import { streamBuiltin, streamPromisesBuiltin } from "./builtins/stream.ts";
import { ttyBuiltin } from "./builtins/tty.ts";
import { urlBuiltin } from "./builtins/url.ts";
import { utilBuiltin } from "./builtins/util.ts";

export function createBuiltinLoader(bindings: BuiltinBindings): (specifier: string) => RuntimeValue {
  const internalBinding = bindings.internalBinding;
  const process = bindings.process || new BrowserProcess();
  return function requireBuiltin(specifier: string): RuntimeValue {
    if (specifier === "fs" || specifier === "node:fs") {
      internalBinding?.("fs");
      return bindings.fs;
    }
    if (specifier === "buffer" || specifier === "node:buffer") return bindings.buffer || bufferBuiltin;
    if (specifier === "events" || specifier === "node:events") return bindings.events || eventsBuiltin;
    if (specifier === "assert" || specifier === "node:assert") return assertBuiltin;
    if (specifier === "assert/strict" || specifier === "node:assert/strict") return assertStrictBuiltin;
    if (specifier === "os" || specifier === "node:os") return osBuiltin;
    if (specifier === "path" || specifier === "node:path") return pathBuiltin;
    if (specifier === "path/posix" || specifier === "node:path/posix") return pathBuiltin.posix;
    if (specifier === "process" || specifier === "node:process") return process;
    if (specifier === "stream" || specifier === "node:stream") return bindings.stream || streamBuiltin;
    if (specifier === "stream/promises" || specifier === "node:stream/promises") return streamPromisesBuiltin;
    if (specifier === "tty" || specifier === "node:tty") return ttyBuiltin;
    if (specifier === "url" || specifier === "node:url") return urlBuiltin;
    if (specifier === "util" || specifier === "node:util") return bindings.util || utilBuiltin;
    throw new Error(`Unsupported builtin module: ${specifier}`);
  };
}
