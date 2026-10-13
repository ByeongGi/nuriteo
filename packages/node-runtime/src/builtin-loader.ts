import type { BuiltinBindings, RuntimeValue } from "./types.ts";
import { asyncHooksBuiltin } from "./builtins/async-hooks.ts";
import { assertBuiltin, strict as assertStrictBuiltin } from "./builtins/assert.ts";
import { bufferBuiltin } from "./builtins/buffer.ts";
import { childProcessBuiltin } from "./builtins/child-process.ts";
import { constantsBuiltin } from "./builtins/constants.ts";
import { cryptoBuiltin } from "./builtins/crypto.ts";
import { dnsBuiltin, dnsPromisesBuiltin } from "./builtins/dns.ts";
import { diagnosticsChannelBuiltin } from "./builtins/diagnostics-channel.ts";
import { eventsBuiltin } from "./builtins/events.ts";
import { createFsPromisesBuiltin } from "./builtins/fs-promises.ts";
import { createHttpBuiltin, createHttpsBuiltin } from "./builtins/http.ts";
import { http2Builtin } from "./builtins/http2.ts";
import { moduleBuiltin } from "./builtins/module.ts";
import { netBuiltin } from "./builtins/net.ts";
import { osBuiltin } from "./builtins/os.ts";
import { pathBuiltin } from "./builtins/path.ts";
import { perfHooksBuiltin } from "./builtins/perf-hooks.ts";
import { BrowserProcess } from "./builtins/process.ts";
import { querystringBuiltin } from "./builtins/querystring.ts";
import { readlineBuiltin } from "./builtins/readline.ts";
import { streamBuiltin, streamPromisesBuiltin, streamWebBuiltin } from "./builtins/stream.ts";
import { stringDecoderBuiltin } from "./builtins/string-decoder.ts";
import { timersBuiltin } from "./builtins/timers-classic.ts";
import { timersPromisesBuiltin } from "./builtins/timers.ts";
import { tlsBuiltin } from "./builtins/tls.ts";
import { ttyBuiltin } from "./builtins/tty.ts";
import { urlBuiltin } from "./builtins/url.ts";
import { utilBuiltin } from "./builtins/util.ts";
import { v8Builtin } from "./builtins/v8.ts";
import { vmBuiltin } from "./builtins/vm.ts";
import { wasiBuiltin } from "./builtins/wasi.ts";
import { workerThreadsBuiltin } from "./builtins/worker-threads-builtin.ts";
import { zlibBuiltin } from "./builtins/zlib.ts";

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
    if (specifier === "child_process" || specifier === "node:child_process") return bindings.childProcess || childProcessBuiltin;
    if (specifier === "events" || specifier === "node:events") return bindings.events || eventsBuiltin;
    if (specifier === "dns" || specifier === "node:dns") return dnsBuiltin;
    if (specifier === "dns/promises" || specifier === "node:dns/promises") return dnsPromisesBuiltin;
    if (specifier === "diagnostics_channel" || specifier === "node:diagnostics_channel") return diagnosticsChannelBuiltin;
    if (specifier === "http" || specifier === "node:http") return createHttpBuiltin(bindings.httpClient, "http:", bindings.httpServerNetwork);
    if (specifier === "http2" || specifier === "node:http2") return http2Builtin;
    if (specifier === "https" || specifier === "node:https") return createHttpsBuiltin(bindings.httpsClient || bindings.httpClient);
    if (specifier === "module" || specifier === "node:module") return bindings.module || moduleBuiltin;
    if (specifier === "net" || specifier === "node:net") return netBuiltin;
    if (specifier === "async_hooks" || specifier === "node:async_hooks") return asyncHooksBuiltin;
    if (specifier === "assert" || specifier === "node:assert") return assertBuiltin;
    if (specifier === "assert/strict" || specifier === "node:assert/strict") return assertStrictBuiltin;
    if (specifier === "constants" || specifier === "node:constants") return constantsBuiltin;
    if (specifier === "console" || specifier === "node:console") return bindings.console || console;
    if (specifier === "crypto" || specifier === "node:crypto") return cryptoBuiltin;
    if (specifier === "os" || specifier === "node:os") return osBuiltin;
    if (specifier === "path" || specifier === "node:path") return bindings.path || pathBuiltin;
    if (specifier === "path/posix" || specifier === "node:path/posix") {
      const boundPath = bindings.path as { posix?: RuntimeValue } | undefined;
      return boundPath?.posix || pathBuiltin.posix;
    }
    if (specifier === "perf_hooks" || specifier === "node:perf_hooks") return perfHooksBuiltin;
    if (specifier === "process" || specifier === "node:process") return process;
    if (specifier === "querystring" || specifier === "node:querystring") return querystringBuiltin;
    if (specifier === "readline" || specifier === "node:readline") return readlineBuiltin;
    if (specifier === "stream" || specifier === "node:stream") return bindings.stream || streamBuiltin;
    if (specifier === "stream/promises" || specifier === "node:stream/promises") return streamPromisesBuiltin;
    if (specifier === "stream/web" || specifier === "node:stream/web") return streamWebBuiltin;
    if (specifier === "string_decoder" || specifier === "node:string_decoder") return stringDecoderBuiltin;
    if (specifier === "timers" || specifier === "node:timers") return bindings.timers || timersBuiltin;
    if (specifier === "timers/promises" || specifier === "node:timers/promises") return bindings.timersPromises || timersPromisesBuiltin;
    if (specifier === "tls" || specifier === "node:tls") return tlsBuiltin;
    if (specifier === "tty" || specifier === "node:tty") return ttyBuiltin;
    if (specifier === "url" || specifier === "node:url") return urlBuiltin;
    if (specifier === "util" || specifier === "node:util") return bindings.util || utilBuiltin;
    if (specifier === "util/types" || specifier === "node:util/types") return utilBuiltin.types;
    if (specifier === "v8" || specifier === "node:v8") return v8Builtin;
    if (specifier === "vm" || specifier === "node:vm") return vmBuiltin;
    if (specifier === "wasi" || specifier === "node:wasi") return wasiBuiltin;
    if (specifier === "worker_threads" || specifier === "node:worker_threads") return bindings.workerThreads || workerThreadsBuiltin;
    if (specifier === "zlib" || specifier === "node:zlib") return zlibBuiltin;
    throw new Error(`Unsupported builtin module: ${specifier}`);
  };
}
