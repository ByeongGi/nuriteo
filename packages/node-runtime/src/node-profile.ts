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
    stream: Object.freeze({ status: "missing", source: "node-v22.23.0" }),
    util: Object.freeze({
      status: "partial",
      source: "browser-native-js",
      implementedBy: "packages/node-runtime/src/builtins/util.ts",
      tests: Object.freeze(["tests/node-runtime/builtin-subset.test.mjs"])
    })
  }),
  dependencyGraph: Object.freeze({
    buffer: Object.freeze(["node:buffer"]),
    events: Object.freeze(["node:events"]),
    "node:fs": Object.freeze(["internalBinding:fs"]),
    "node:buffer": Object.freeze(["browser-native-js:buffer"]),
    "node:events": Object.freeze(["browser-native-js:events"]),
    "node:util": Object.freeze(["browser-native-js:util", "node:events"]),
    "fs": Object.freeze(["node:fs"]),
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
  return Object.entries(NODE_PROFILE.builtins)
    .filter(([, profile]) => profile.status === "missing")
    .map(([name, profile]) => ({ name, source: profile.source }));
}
