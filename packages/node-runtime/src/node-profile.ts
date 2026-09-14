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
    buffer: Object.freeze({ status: "missing", source: "node-v22.23.0" }),
    events: Object.freeze({ status: "missing", source: "node-v22.23.0" }),
    stream: Object.freeze({ status: "missing", source: "node-v22.23.0" }),
    util: Object.freeze({ status: "missing", source: "node-v22.23.0" })
  }),
  dependencyGraph: Object.freeze({
    "node:fs": Object.freeze(["internalBinding:fs"]),
    "fs": Object.freeze(["node:fs"])
  })
});

export function getBuiltinProfile(specifier) {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return NODE_PROFILE.builtins[normalized] || null;
}

export function getUnsupportedBuiltins() {
  return Object.entries(NODE_PROFILE.builtins)
    .filter(([, profile]) => profile.status === "missing")
    .map(([name, profile]) => ({ name, source: profile.source }));
}
