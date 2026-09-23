import assert from "node:assert/strict";

import {
  createFallbackLineChanges,
  summarizeDiffChanges
} from "../src/lib/diffSummary.ts";

const summary = summarizeDiffChanges([
  {
    originalStartLineNumber: 2,
    originalEndLineNumber: 3,
    modifiedStartLineNumber: 2,
    modifiedEndLineNumber: 4
  },
  {
    originalStartLineNumber: 8,
    originalEndLineNumber: 8,
    modifiedStartLineNumber: 0,
    modifiedEndLineNumber: 0
  },
  {
    originalStartLineNumber: 0,
    originalEndLineNumber: 0,
    modifiedStartLineNumber: 10,
    modifiedEndLineNumber: 11
  }
]);

assert.deepEqual(summary, {
  added: 3,
  removed: 1,
  changed: 2,
  hunks: 3
});
assert.deepEqual(summarizeDiffChanges([]), { added: 0, removed: 0, changed: 0, hunks: 0 });

assert.deepEqual(
  createFallbackLineChanges("same\nold\ntail", "same\nnew\nextra\ntail"),
  [{
    originalStartLineNumber: 2,
    originalEndLineNumber: 2,
    modifiedStartLineNumber: 2,
    modifiedEndLineNumber: 3
  }]
);
assert.deepEqual(createFallbackLineChanges("same", "same"), []);

console.log("preview service diff summary ok");
