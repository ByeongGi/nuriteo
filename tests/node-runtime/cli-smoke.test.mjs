import assert from "node:assert/strict";

import { getUnsupportedBuiltins } from "../../packages/node-runtime/src/node-profile.ts";

const unsupported = getUnsupportedBuiltins().map((binding) => binding.name).sort();
assert.deepEqual(unsupported, ["stream"]);

const attempts = [
  {
    command: "npm --version",
    status: "blocked",
    missingBindings: unsupported
  },
  {
    command: "pnpm --version",
    status: "blocked",
    missingBindings: unsupported
  }
];

for (const attempt of attempts) {
  assert.equal(attempt.status, "blocked");
  assert.ok(attempt.missingBindings.includes("stream"));
}

console.log(JSON.stringify({ attempts }, null, 2));
console.log("node cli smoke test ok");
