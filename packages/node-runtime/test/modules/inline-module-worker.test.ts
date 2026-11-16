import assert from "node:assert/strict";

import { moduleWorkerBlobSource } from "../../../workers/inline-module-worker.ts";

const source = [
  "const factoryUrl = new URL(\"./vendor/next-cli.mjs\", self.location.href);",
  "await fetch(factoryUrl);"
].join("\n");
const blobSource = moduleWorkerBlobSource(source, "https://nuriteo.test/runtime/hash/");

assert.match(blobSource, /^URL\.revokeObjectURL\(import\.meta\.url\);\n/u);
assert.match(blobSource, /new URL\("\.\/vendor\/next-cli\.mjs", "https:\/\/nuriteo\.test\/runtime\/hash\/"\)/u);
assert.doesNotMatch(blobSource, /self\.location\.href/u);

console.log("inline module worker test ok");
