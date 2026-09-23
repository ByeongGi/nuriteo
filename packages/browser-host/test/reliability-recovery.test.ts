import assert from "node:assert/strict";
import {
  createRuntimeRecoveryPlan,
  createStorageLease,
  StorageLeaseError
} from "../../browser-host/src/index.ts";
import { createPreviewReliabilitySession } from "../../preview-service/src/reliability.ts";

const lease = createStorageLease({ ttlMs: 30_000 });
lease.acquire("tab-a");
assert.throws(
  () => lease.acquire("tab-b"),
  (error) => error instanceof StorageLeaseError && error.code === "ELEASEHELD"
);

const leasePlan = createRuntimeRecoveryPlan({
  diagnostics: [{
    code: "ELEASEHELD",
    severity: "error",
    message: "storage writer lease held by tab-a",
    source: "storage"
  }]
});
assert.ok(leasePlan.actions.some((action) => action.kind === "resolve-writer-conflict"));

const session = createPreviewReliabilitySession({
  policy: {
    storage: {
      quotaBytesDefault: 2048,
      evictionPrefixes: ["cache/", "packages/"],
      protectedPrefixes: ["projects/"],
      writerLeaseTtlMs: 30_000
    }
  }
});
session.acquireWriter();
session.writeCacheFile("projects/keep.json", "keep");
let quotaDiagnostic = null;
try {
  session.writeCacheFile("cache/big.json", "x".repeat(4096));
} catch (error) {
  quotaDiagnostic = session.handleStorageError(error);
}
assert.equal(quotaDiagnostic?.code, "EOPFSQUOTA");
const quotaPlan = session.createRecoveryPlan([quotaDiagnostic]);
assert.ok(quotaPlan.actions.some((action) => action.kind === "clear-cache"));
const cleared = session.clearPackageCache();
assert.ok(cleared.freedBytes >= 0);

const foreign = createPreviewReliabilitySession({ owner: "tab-a" });
foreign.acquireWriter();
const contested = createPreviewReliabilitySession({
  owner: "tab-b",
  policy: {
    storage: {
      quotaBytesDefault: 2048,
      evictionPrefixes: ["cache/"],
      protectedPrefixes: ["projects/"],
      writerLeaseTtlMs: 30_000
    }
  }
});
// Simulate shared lease by reusing the first session lease object.
contested.lease.owner = foreign.lease.owner;
contested.lease.expiresAt = foreign.lease.expiresAt;
assert.throws(() => contested.acquireWriter(), (error) => error.code === "ELEASEHELD");
contested.forceTakeWriter();
assert.equal(contested.lease.owner, contested.owner);

console.log("reliability recovery ok");
