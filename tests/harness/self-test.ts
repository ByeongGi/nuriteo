import assert from "node:assert/strict";
import { runReferenceNode } from "./reference-node.ts";
import { runBrowserWorker } from "./browser.ts";
import { normalizeRunResult, compareRunResults } from "./compare.ts";

const source = `
  console.log("hello");
  console.error("warn");
  fs.writeFileSync("out.txt", "artifact");
  process.exitCode = 7;
`;

const reference = normalizeRunResult(await runReferenceNode(`
  import fs from "node:fs";
  console.log("hello");
  console.error("warn");
  fs.writeFileSync("out.txt", "artifact");
  process.exitCode = 7;
`, { assertFiles: ["out.txt"] }));

const browser = normalizeRunResult(await runBrowserWorker(source, { assertFiles: ["out.txt"] }));

assert.deepEqual(compareRunResults(browser, reference), []);

const mismatch = compareRunResults({
  ...browser,
  status: 0,
  stdoutBase64: Buffer.from("different\n").toString("base64")
}, reference);

assert.ok(mismatch.some((item) => item.startsWith("status:")));
assert.ok(mismatch.includes("stdout bytes differ"));

console.log("harness self-test ok");
