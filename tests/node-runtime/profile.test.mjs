import assert from "node:assert/strict";
import fs from "node:fs";

import { createInternalBindingRegistry, UnsupportedBindingError } from "../../packages/node-runtime/src/internal-binding.ts";
import { getBuiltinProfile, getUnsupportedBuiltins, NODE_PROFILE } from "../../packages/node-runtime/src/node-profile.ts";

const manifest = JSON.parse(fs.readFileSync(new URL("../../compat/node-bindings.json", import.meta.url), "utf8"));

assert.equal(NODE_PROFILE.nodeVersion, manifest.nodeVersion);
assert.equal(NODE_PROFILE.csp.unsafeEval, false);
assert.equal(getBuiltinProfile("node:fs").status, "partial");
assert.equal(getBuiltinProfile("fs").implementedBy, "packages/node-runtime/src/bindings/fs.ts");

const missing = getUnsupportedBuiltins().map((binding) => binding.name);
for (const name of ["stream"]) {
  assert.ok(missing.includes(name), `${name} must remain visible as unsupported`);
}
for (const name of ["buffer", "events", "util"]) {
  assert.equal(getBuiltinProfile(name).status, "partial");
  assert.ok(getBuiltinProfile(name).implementedBy.startsWith("packages/node-runtime/src/builtins/"));
}

const internalBinding = createInternalBindingRegistry({});
assert.throws(
  () => internalBinding("stream"),
  (error) => error instanceof UnsupportedBindingError
    && error.code === "ERR_CARGO_CONTAINER_UNSUPPORTED_BINDING"
    && error.binding === "stream"
    && error.profile.status === "missing"
);

console.log("node profile test ok");
