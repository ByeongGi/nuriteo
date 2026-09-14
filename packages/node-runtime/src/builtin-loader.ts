import type { BuiltinBindings, RuntimeValue } from "./types.ts";
import { assertBuiltin, strict as assertStrictBuiltin } from "./builtins/assert.ts";
import { bufferBuiltin } from "./builtins/buffer.ts";
import { childProcessBuiltin } from "./builtins/child-process.ts";
import { constantsBuiltin } from "./builtins/constants.ts";
import { cryptoBuiltin } from "./builtins/crypto.ts";
import { dnsBuiltin, dnsPromisesBuiltin } from "./builtins/dns.ts";
import { eventsBuiltin } from "./builtins/events.ts";
import { createFsPromisesBuiltin } from "./builtins/fs-promises.ts";
import { createHttpBuiltin, createHttpsBuiltin } from "./builtins/http.ts";
import { http2Builtin } from "./builtins/http2.ts";
import { moduleBuiltin } from "./builtins/module.ts";
import { netBuiltin } from "./builtins/net.ts";
import { osBuiltin } from "./builtins/os.ts";
import { pathBuiltin } from "./builtins/path.ts";
import { BrowserProcess } from "./builtins/process.ts";
import { querystringBuiltin } from "./builtins/querystring.ts";
import { readlineBuiltin } from "./builtins/readline.ts";
import { streamBuiltin, streamPromisesBuiltin } from "./builtins/stream.ts";
import { stringDecoderBuiltin } from "./builtins/string-decoder.ts";
import { timersPromisesBuiltin } from "./builtins/timers.ts";
import { tlsBuiltin } from "./builtins/tls.ts";
import { ttyBuiltin } from "./builtins/tty.ts";
import { urlBuiltin } from "./builtins/url.ts";
import { utilBuiltin } from "./builtins/util.ts";
import { workerThreadsBuiltin } from "./builtins/worker-threads-builtin.ts";

export function createBuiltinLoader(bindings: BuiltinBindings): (specifier: string) => RuntimeValue {
  const internalBinding = bindings.internalBinding;
  const process = bindings.process || new BrowserProcess();
  return function requireBuiltin(specifier: string): RuntimeValue {
    if (specifier === "fs" || specifier === "node:fs") {
      internalBinding?.("fs");
      return bindings.fs;
    }
    if (specifier === "fs/promises" || specifier === "node:fs/promises") {
      internalBinding?.("fs");
      if (!bindings.fs) throw new Error("fs/promises requires an fs binding");
      return createFsPromisesBuiltin(bindings.fs);
    }
    if (specifier === "buffer" || specifier === "node:buffer") return bindings.buffer || bufferBuiltin;
    if (specifier === "child_process" || specifier === "node:child_process") return childProcessBuiltin;
    if (specifier === "events" || specifier === "node:events") return bindings.events || eventsBuiltin;
    if (specifier === "dns" || specifier === "node:dns") return dnsBuiltin;
    if (specifier === "dns/promises" || specifier === "node:dns/promises") return dnsPromisesBuiltin;
    if (specifier === "http" || specifier === "node:http") return createHttpBuiltin(bindings.httpClient);
    if (specifier === "http2" || specifier === "node:http2") return http2Builtin;
    if (specifier === "https" || specifier === "node:https") return createHttpsBuiltin(bindings.httpsClient || bindings.httpClient);
    if (specifier === "module" || specifier === "node:module") return moduleBuiltin;
    if (specifier === "net" || specifier === "node:net") return netBuiltin;
    if (specifier === "assert" || specifier === "node:assert") return assertBuiltin;
    if (specifier === "assert/strict" || specifier === "node:assert/strict") return assertStrictBuiltin;
    if (specifier === "constants" || specifier === "node:constants") return constantsBuiltin;
    if (specifier === "crypto" || specifier === "node:crypto") return cryptoBuiltin;
    if (specifier === "os" || specifier === "node:os") return osBuiltin;
    if (specifier === "path" || specifier === "node:path") return pathBuiltin;
    if (specifier === "path/posix" || specifier === "node:path/posix") return pathBuiltin.posix;
    if (specifier === "process" || specifier === "node:process") return process;
    if (specifier === "querystring" || specifier === "node:querystring") return querystringBuiltin;
    if (specifier === "readline" || specifier === "node:readline") return readlineBuiltin;
    if (specifier === "stream" || specifier === "node:stream") return bindings.stream || streamBuiltin;
    if (specifier === "stream/promises" || specifier === "node:stream/promises") return streamPromisesBuiltin;
    if (specifier === "string_decoder" || specifier === "node:string_decoder") return stringDecoderBuiltin;
    if (specifier === "timers/promises" || specifier === "node:timers/promises") return timersPromisesBuiltin;
    if (specifier === "tls" || specifier === "node:tls") return tlsBuiltin;
    if (specifier === "tty" || specifier === "node:tty") return ttyBuiltin;
    if (specifier === "url" || specifier === "node:url") return urlBuiltin;
    if (specifier === "util" || specifier === "node:util") return bindings.util || utilBuiltin;
    if (specifier === "worker_threads" || specifier === "node:worker_threads") return workerThreadsBuiltin;
    throw new Error(`Unsupported builtin module: ${specifier}`);
  };
}
