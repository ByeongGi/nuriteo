import assert from "node:assert/strict";
import fs from "node:fs";

import { createInternalBindingRegistry, UnsupportedBindingError } from "../../node-runtime/src/internal-binding.ts";
import { getBuiltinProfile, getUnsupportedBuiltins, NODE_PROFILE } from "../../node-runtime/src/node-profile.ts";

const manifest = JSON.parse(fs.readFileSync(new URL("../../../compat/node-bindings.json", import.meta.url), "utf8"));

assert.equal(NODE_PROFILE.nodeVersion, manifest.nodeVersion);
assert.equal(NODE_PROFILE.csp.unsafeEval, false);
assert.equal(getBuiltinProfile("node:fs").status, "partial");
assert.equal(getBuiltinProfile("fs").implementedBy, "packages/node-runtime/src/bindings/fs.ts");

const missing = getUnsupportedBuiltins().map((binding) => binding.name).sort();
assert.deepEqual(missing, []);
for (const name of ["assert", "buffer", "events", "module", "os", "path", "process", "stream", "tty", "url", "util"]) {
  assert.equal(getBuiltinProfile(name).status, "partial");
  assert.ok(getBuiltinProfile(name).implementedBy.startsWith("packages/node-runtime/src/builtins/"));
}

const internalBinding = createInternalBindingRegistry({});
assert.throws(
  () => internalBinding("stream_wrap"),
  (error) => error instanceof UnsupportedBindingError
    && error.code === "ERR_NURITEO_UNSUPPORTED_BINDING"
    && error.binding === "stream_wrap"
    && error.profile.status === "unknown"
);

console.log("node profile test ok");
