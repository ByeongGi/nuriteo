import assert from "node:assert/strict";

import {
  createPreviewHistory,
  movePreviewHistory,
  normalizePreviewAddress,
  recordPreviewHistory
} from "../src/runtime/preview-address.ts";

assert.equal(normalizePreviewAddress("  "), "/");
assert.equal(normalizePreviewAddress("about"), "/about");
assert.equal(normalizePreviewAddress("/docs?q=1#start"), "/docs?q=1#start");
assert.equal(normalizePreviewAddress("https://preview.example/app/board"), "/app/board");
assert.equal(normalizePreviewAddress("javascript:alert(1)"), null);
assert.equal(normalizePreviewAddress("/../secret"), null);
assert.equal(normalizePreviewAddress("//evil.example/phish"), null);

let history = createPreviewHistory();
history = recordPreviewHistory(history, "/one");
history = recordPreviewHistory(history, "/two");
assert.deepEqual(history, { entries: ["/", "/one", "/two"], index: 2 });
history = movePreviewHistory(history, -1);
assert.equal(history.index, 1);
assert.equal(history.entries[history.index], "/one");
history = recordPreviewHistory(history, "/three");
assert.deepEqual(history.entries, ["/", "/one", "/three"]);
assert.equal(movePreviewHistory(history, 1), history);
history = movePreviewHistory(createPreviewHistory(), -1);
assert.equal(history.index, 0);

console.log("preview address normalizes project paths and keeps back-forward history");
