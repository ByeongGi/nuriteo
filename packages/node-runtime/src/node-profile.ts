export const NODE_PROFILE = Object.freeze({
  name: "node-22-browser-native-p3",
  nodeVersion: "22.23.0",
  abiVersion: 1,
  csp: Object.freeze({
    unsafeEval: false,
    dynamicEvaluation: "disabled"
  }),
  builtins: Object.freeze({
    fs: Object.freeze({
      status: "partial",
      source: "local-sab-syscall-adapter",
      implementedBy: "packages/node-runtime/src/bindings/fs.ts",
      tests: Object.freeze(["tests/system/browser/boot.test.ts"])
    }),
    "fs/promises": Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/fs-promises.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    http: Object.freeze({
      status: "partial",
      source: "browser-fetch-adapter",
      implementedBy: "packages/node-runtime/src/builtins/http.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    http2: Object.freeze({
      status: "partial",
      source: "browser-unsupported-diagnostic",
      implementedBy: "packages/node-runtime/src/builtins/http2.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    https: Object.freeze({
      status: "partial",
      source: "browser-fetch-adapter",
      implementedBy: "packages/node-runtime/src/builtins/http.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    net: Object.freeze({
      status: "partial",
      source: "browser-unsupported-diagnostic",
      implementedBy: "packages/node-runtime/src/builtins/net.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    assert: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/assert.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    async_hooks: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/async-hooks.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    buffer: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/buffer.ts",
      tests: Object.freeze(["packages/node-runtime/test/builtin-subset.test.ts"])
    }),
    child_process: Object.freeze({
      status: "partial",
      source: "browser-unsupported-diagnostic",
      implementedBy: "packages/node-runtime/src/builtins/child-process.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    constants: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/constants.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    crypto: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/crypto.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts", "tests/compatibility/package-managers/fetcher.test.ts"])
    }),
    dns: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/dns.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    events: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/events.ts",
      tests: Object.freeze(["packages/node-runtime/test/builtin-subset.test.ts"])
    }),
    module: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/module.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    os: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/os.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    path: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/path.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    perf_hooks: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/perf-hooks.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    process: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/process.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    querystring: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/querystring.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    readline: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/readline.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    stream: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/stream.ts",
      tests: Object.freeze(["packages/node-runtime/test/stream-subset.test.ts"])
    }),
    string_decoder: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/string-decoder.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    timers: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/timers-classic.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    "timers/promises": Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/timers.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    tls: Object.freeze({
      status: "partial",
      source: "browser-unsupported-diagnostic",
      implementedBy: "packages/node-runtime/src/builtins/tls.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    tty: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/tty.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    url: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/url.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    util: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/util.ts",
      tests: Object.freeze(["packages/node-runtime/test/builtin-subset.test.ts"])
    }),
    v8: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/v8.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    wasi: Object.freeze({
      status: "partial",
      source: "browser-wasi-facade",
      implementedBy: "packages/node-runtime/src/builtins/wasi.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    }),
    worker_threads: Object.freeze({
      status: "partial",
      source: "browser-unsupported-diagnostic",
      implementedBy: "packages/node-runtime/src/builtins/worker-threads-builtin.ts",
      tests: Object.freeze(["packages/node-runtime/test/secondary-builtins.test.ts"])
    })
  }),
  dependencyGraph: Object.freeze({
    assert: Object.freeze(["node:assert"]),
    "assert/strict": Object.freeze(["node:assert/strict"]),
    buffer: Object.freeze(["node:buffer"]),
    events: Object.freeze(["node:events"]),
    "node:fs": Object.freeze(["internalBinding:fs"]),
    "node:assert": Object.freeze(["browser-native-js:assert"]),
    "node:assert/strict": Object.freeze(["node:assert"]),
    "node:async_hooks": Object.freeze(["browser-native-js:async_hooks"]),
    "node:buffer": Object.freeze(["browser-native-js:buffer"]),
    "node:child_process": Object.freeze(["browser-unsupported-diagnostic"]),
    "node:constants": Object.freeze(["browser-native-js:constants"]),
    "node:crypto": Object.freeze(["browser-native-js:crypto"]),
    "node:dns": Object.freeze(["browser-native-js:dns"]),
    "node:dns/promises": Object.freeze(["node:dns"]),
    "node:events": Object.freeze(["browser-native-js:events"]),
    "node:module": Object.freeze(["browser-native-js:module"]),
    "node:fs/promises": Object.freeze(["node:fs"]),
    "node:http": Object.freeze(["browser-fetch-adapter"]),
    "node:http2": Object.freeze(["browser-unsupported-diagnostic"]),
    "node:https": Object.freeze(["browser-fetch-adapter"]),
    "node:net": Object.freeze(["browser-unsupported-diagnostic"]),
    "node:os": Object.freeze(["browser-native-js:os"]),
    "node:path": Object.freeze(["browser-native-js:path"]),
    "node:path/posix": Object.freeze(["node:path"]),
    "node:perf_hooks": Object.freeze(["browser-native-js:perf_hooks"]),
    "node:process": Object.freeze(["browser-native-js:process"]),
    "node:querystring": Object.freeze(["browser-native-js:querystring"]),
    "node:readline": Object.freeze(["browser-native-js:readline", "node:events"]),
    "node:stream": Object.freeze(["browser-native-js:stream", "node:events"]),
    "node:stream/promises": Object.freeze(["node:stream"]),
    "node:string_decoder": Object.freeze(["browser-native-js:string_decoder", "node:buffer"]),
    "node:timers": Object.freeze(["browser-native-js:timers"]),
    "node:timers/promises": Object.freeze(["browser-native-js:timers"]),
    "node:tls": Object.freeze(["node:net", "browser-unsupported-diagnostic"]),
    "node:tty": Object.freeze(["browser-native-js:tty", "node:stream"]),
    "node:url": Object.freeze(["browser-native-js:url", "node:path"]),
    "node:util": Object.freeze(["browser-native-js:util", "node:events"]),
    "node:v8": Object.freeze(["browser-native-js:v8"]),
    "node:wasi": Object.freeze(["browser-wasi-facade"]),
    "node:worker_threads": Object.freeze(["browser-unsupported-diagnostic"]),
    "async_hooks": Object.freeze(["node:async_hooks"]),
    "child_process": Object.freeze(["node:child_process"]),
    "crypto": Object.freeze(["node:crypto"]),
    "fs": Object.freeze(["node:fs"]),
    "fs/promises": Object.freeze(["node:fs/promises"]),
    "dns": Object.freeze(["node:dns"]),
    "dns/promises": Object.freeze(["node:dns/promises"]),
    "http": Object.freeze(["node:http"]),
    "http2": Object.freeze(["node:http2"]),
    "https": Object.freeze(["node:https"]),
    "module": Object.freeze(["node:module"]),
    "net": Object.freeze(["node:net"]),
    "os": Object.freeze(["node:os"]),
    "path": Object.freeze(["node:path"]),
    "path/posix": Object.freeze(["node:path/posix"]),
    "perf_hooks": Object.freeze(["node:perf_hooks"]),
    "process": Object.freeze(["node:process"]),
    "querystring": Object.freeze(["node:querystring"]),
    "readline": Object.freeze(["node:readline"]),
    "stream": Object.freeze(["node:stream"]),
    "stream/promises": Object.freeze(["node:stream/promises"]),
    "string_decoder": Object.freeze(["node:string_decoder"]),
    "timers": Object.freeze(["node:timers"]),
    "timers/promises": Object.freeze(["node:timers/promises"]),
    "tls": Object.freeze(["node:tls"]),
    "tty": Object.freeze(["node:tty"]),
    "url": Object.freeze(["node:url"]),
    "util": Object.freeze(["node:util"]),
    "v8": Object.freeze(["node:v8"]),
    "wasi": Object.freeze(["node:wasi"]),
    "worker_threads": Object.freeze(["node:worker_threads"])
  })
});

type BuiltinName = keyof typeof NODE_PROFILE.builtins;

export function getBuiltinProfile(specifier: string): (typeof NODE_PROFILE.builtins)[BuiltinName] | null {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return normalized in NODE_PROFILE.builtins
    ? NODE_PROFILE.builtins[normalized as BuiltinName]
    : null;
}

export function getUnsupportedBuiltins(): Array<{ name: string; source: string }> {
  const builtins = NODE_PROFILE.builtins as Record<string, { status: string; source: string }>;
  return Object.entries(builtins)
    .filter(([, profile]) => profile.status === "missing")
    .map(([name, profile]) => ({ name, source: profile.source }));
}
