import { readdir } from "node:fs/promises";

// The browser workflow soak has its own `test:workflow-soak` command. Keeping it
// out of the default suite avoids multiplying its runtime and lets fixed-port
// browser tests run sequentially.
const standaloneTests = new Set(["edge-browser-smoke.test.mjs", "workflow-soak.test.mjs"]);
const tests = (await readdir(new URL(".", import.meta.url)))
  .filter((file) => file.endsWith(".test.mjs") && !standaloneTests.has(file))
  .sort();

for (const test of tests) {
  await import(`./${test}`);
}
