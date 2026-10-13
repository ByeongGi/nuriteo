import assert from "node:assert/strict";

import { createGitHostTransportBoundary } from "../../node-runtime/src/tooling/index.ts";

function packfile(bytes = 12, version = 2, objectCount = 0): Uint8Array {
  const value = new Uint8Array(bytes);
  value.set(new TextEncoder().encode("PACK"));
  const view = new DataView(value.buffer);
  view.setUint32(4, version, false);
  view.setUint32(8, objectCount, false);
  return value;
}

const requests = [];
const boundary = createGitHostTransportBoundary({
  maxPackfileBytes: 1024,
  async fetch(request) {
    requests.push(request);
    return { packfile: packfile(1024, 2, 7) };
  }
});
const credentialHandle = "git-cred:0123456789abcdef";
const startedAt = performance.now();
const result = await boundary.fetch("https://example.test/org/repo.git", { credentialHandle });
assert.equal(result.bytes, 1024);
assert.equal(result.version, 2);
assert.equal(result.objectCount, 7);
assert.equal(result.remoteOrigin, "https://example.test");
assert.equal(requests[0].credentialHandle, credentialHandle);
assert(performance.now() - startedAt < 50, "Git packfile boundary exceeded 50ms");
await assert.rejects(boundary.fetch("https://example.test/org/repo.git", { credentialHandle }), { code: "EGITCREDENTIAL" });

const oversizedPackfile = packfile(64 * 1024 * 1024 + 1);
const oversized = createGitHostTransportBoundary({ async fetch() { return { packfile: oversizedPackfile }; } });
const oversizedStartedAt = performance.now();
await assert.rejects(oversized.fetch("https://example.test/repo.git"), { code: "EGITPACKLIMIT" });
assert(performance.now() - oversizedStartedAt < 250, "oversized Git packfile admission exceeded 250ms");
const malformed = createGitHostTransportBoundary({ async fetch() { return { packfile: new Uint8Array(12) }; } });
await assert.rejects(malformed.fetch("https://example.test/repo.git"), { code: "EGITPACK" });

for (const remote of ["http://example.test/repo.git", "https://token:super-secret@example.test/repo.git", "https://example.test/repo.git?token=super-secret", "not-a-url"]) {
  await assert.rejects(boundary.fetch(remote), (error: Error & { code?: string }) => {
    return error.code === "EGITREMOTE" && !error.message.includes("super-secret") && !error.message.includes(remote);
  });
}
const failing = createGitHostTransportBoundary({ async fetch() { throw new Error("token=super-secret remote=https://private.test"); } });
await assert.rejects(failing.fetch("https://private.test/repo.git", { credentialHandle: "git-cred:fedcba9876543210" }), (error: Error & { code?: string }) => {
  return error.code === "EGITTRANSPORT" && !error.message.includes("secret") && !error.message.includes("private.test");
});

console.log("Git host transport boundary test ok");
