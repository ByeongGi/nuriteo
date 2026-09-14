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
      tests: Object.freeze(["tests/browser/boot.test.mjs"])
    }),
    assert: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/assert.ts",
      tests: Object.freeze(["tests/node-runtime/secondary-builtins.test.mjs"])
    }),
    buffer: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/buffer.ts",
      tests: Object.freeze(["tests/node-runtime/builtin-subset.test.mjs"])
    }),
    events: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/events.ts",
      tests: Object.freeze(["tests/node-runtime/builtin-subset.test.mjs"])
    }),
    os: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/os.ts",
      tests: Object.freeze(["tests/node-runtime/secondary-builtins.test.mjs"])
    }),
    path: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/path.ts",
      tests: Object.freeze(["tests/node-runtime/secondary-builtins.test.mjs"])
    }),
    process: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/process.ts",
      tests: Object.freeze(["tests/node-runtime/secondary-builtins.test.mjs"])
    }),
    stream: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/stream.ts",
      tests: Object.freeze(["tests/node-runtime/stream-subset.test.mjs"])
    }),
    tty: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/tty.ts",
      tests: Object.freeze(["tests/node-runtime/secondary-builtins.test.mjs"])
    }),
    url: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/url.ts",
      tests: Object.freeze(["tests/node-runtime/secondary-builtins.test.mjs"])
    }),
    util: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/util.ts",
      tests: Object.freeze(["tests/node-runtime/builtin-subset.test.mjs"])
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
    "node:buffer": Object.freeze(["browser-native-js:buffer"]),
    "node:events": Object.freeze(["browser-native-js:events"]),
    "node:os": Object.freeze(["browser-native-js:os"]),
    "node:path": Object.freeze(["browser-native-js:path"]),
    "node:path/posix": Object.freeze(["node:path"]),
    "node:process": Object.freeze(["browser-native-js:process"]),
    "node:stream": Object.freeze(["browser-native-js:stream", "node:events"]),
    "node:stream/promises": Object.freeze(["node:stream"]),
    "node:tty": Object.freeze(["browser-native-js:tty", "node:stream"]),
    "node:url": Object.freeze(["browser-native-js:url", "node:path"]),
    "node:util": Object.freeze(["browser-native-js:util", "node:events"]),
    "fs": Object.freeze(["node:fs"]),
    "os": Object.freeze(["node:os"]),
    "path": Object.freeze(["node:path"]),
    "path/posix": Object.freeze(["node:path/posix"]),
    "process": Object.freeze(["node:process"]),
    "stream": Object.freeze(["node:stream"]),
    "stream/promises": Object.freeze(["node:stream/promises"]),
    "tty": Object.freeze(["node:tty"]),
    "url": Object.freeze(["node:url"]),
    "util": Object.freeze(["node:util"])
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
