import { readdir } from "node:fs/promises";

// The browser workflow soak has its own `test:workflow-soak` command. Keeping it
// out of the default suite avoids multiplying its runtime and lets fixed-port
// browser tests run sequentially.
const standaloneTests = new Set(["bundler-browser-worker.test.ts", "edge-browser-smoke.test.ts", "safari-browser-smoke.test.ts", "workflow-soak.test.ts"]);
const tests = (await readdir(new URL(".", import.meta.url)))
  .filter((file) => file.endsWith(".test.ts") && !standaloneTests.has(file))
  .sort();

for (const test of tests) {
  await import(`./${test}`);
}
