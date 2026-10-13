import assert from "node:assert/strict";

import { createRetryableLazyFeature } from "../src/lib/retryable-lazy-feature.ts";

let attempts = 0;
const firstFailure = new Error("chunk unavailable");
const feature = createRetryableLazyFeature(async () => {
  attempts += 1;
  if (attempts === 1) throw firstFailure;
  return { revision: "ready" };
});

await assert.rejects(feature.load(), (error: unknown) => error === firstFailure);
assert.deepEqual(await feature.load(), { revision: "ready" });
assert.equal(attempts, 2, "a failed lazy feature must be loaded again instead of caching rejection");

const inFlight = createRetryableLazyFeature(async () => ({ revision: "shared" }));
const left = inFlight.load();
const right = inFlight.load();
assert.equal(left, right, "concurrent lazy feature consumers must share one attempt");

inFlight.reset();
assert.notEqual(inFlight.load(), left, "explicit reset must allow a fresh feature attempt");

console.log("retryable lazy feature tests ok");
