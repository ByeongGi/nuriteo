import assert from "node:assert/strict";
import fs from "node:fs";

import { getUnsupportedBuiltins, NODE_PROFILE } from "../../node-runtime/src/node-profile.ts";

const gap = JSON.parse(fs.readFileSync(new URL("../../../compat/node-api-gap.json", import.meta.url), "utf8"));

assert.equal(gap.schemaVersion, 1);
assert.equal(gap.runtimeProfile, NODE_PROFILE.name);
assert.equal(gap.nodeVersion, NODE_PROFILE.nodeVersion);
assert.ok(Array.isArray(gap.gaps));
assert.ok(Array.isArray(gap.callTraces));

const gapsByName = new Map(gap.gaps.map((entry) => [entry.builtin, entry]));
const unsupported = getUnsupportedBuiltins().map((binding) => binding.name).sort();

for (const name of unsupported) {
  const entry = gapsByName.get(name);
  assert.ok(entry, `${name} must have a node-api-gap entry`);
  assert.equal(entry.status, "missing");
  assert.ok(entry.minimumApi.length > 0, `${name} must declare minimum APIs`);
  assert.ok(entry.acceptance.length > 0, `${name} must declare acceptance criteria`);
}

for (const name of [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "constants",
  "crypto",
  "dns",
  "events",
  "fs/promises",
  "http",
  "http2",
  "https",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "wasi",
  "worker_threads"
]) {
  const entry = gapsByName.get(name);
  assert.equal(entry?.status, "partial");
  assert.ok(entry.implementedBy.startsWith("packages/node-runtime/src/builtins/"));
  assert.ok(entry.tests.length > 0);
}

const blockedCommands = gap.callTraces.filter((trace) => trace.status === "ready-for-guest-runtime-smoke");
assert.ok(blockedCommands.length >= 2);
for (const trace of blockedCommands) {
  assert.deepEqual([...trace.missingBuiltins].sort(), unsupported);
  assert.ok(trace.resolvedBuiltins.includes("stream"));
}

const priorities = gap.gaps.map((entry) => entry.priority);
assert.equal(Math.min(...priorities), 0);

console.log("node api gap inventory test ok");
