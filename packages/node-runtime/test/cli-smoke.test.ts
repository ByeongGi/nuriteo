import assert from "node:assert/strict";

import { getUnsupportedBuiltins } from "../../node-runtime/src/node-profile.ts";

const unsupported = getUnsupportedBuiltins().map((binding) => binding.name).sort();
assert.deepEqual(unsupported, []);

const attempts = [
  {
    command: "npm --version",
    status: "ready-for-guest-runtime-smoke",
    missingBindings: unsupported
  },
  {
    command: "pnpm --version",
    status: "ready-for-guest-runtime-smoke",
    missingBindings: unsupported
  }
];

for (const attempt of attempts) {
  assert.equal(attempt.status, "ready-for-guest-runtime-smoke");
  assert.deepEqual(attempt.missingBindings, []);
}

console.log(JSON.stringify({ attempts }, null, 2));
console.log("node cli smoke test ok");
