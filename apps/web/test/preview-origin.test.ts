import assert from "node:assert/strict";
import fs from "node:fs";

import {
  createPreviewOriginUrl,
  parseInternalPreviewUrl,
  parsePreviewHost,
  resolvePreviewOriginConfiguration
} from "../src/runtime/preview-origin-contract.ts";
import { issueSignedPreviewBinding, verifySignedPreviewBinding } from "../src/lib/preview/signed-binding.ts";

const runtimeId = "a".repeat(45);
const projectId = "019a4a82-1640-7000-8000-000000000001";
const maximumBaseDomain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.dddddd`;
assert.equal(maximumBaseDomain.length, 198);
assert.equal(resolvePreviewOriginConfiguration({
  NURITEO_EXTERNAL_URL: "https://app.example.com",
  NURITEO_PREVIEW_BASE_DOMAIN: maximumBaseDomain,
  NURITEO_PREVIEW_WILDCARD_READY: "true"
}).status, "enabled");
assert.equal(resolvePreviewOriginConfiguration({
  NURITEO_EXTERNAL_URL: "https://app.example.com",
  NURITEO_PREVIEW_BASE_DOMAIN: `${maximumBaseDomain}x`,
  NURITEO_PREVIEW_WILDCARD_READY: "true"
}).status, "disabled");

const local = resolvePreviewOriginConfiguration({
  NURITEO_EXTERNAL_URL: "http://app.localhost:3042",
  NURITEO_PREVIEW_BASE_DOMAIN: "preview.localhost"
});
assert.deepEqual(local, {
  status: "enabled",
  applicationOrigin: "http://app.localhost:3042",
  baseDomain: "preview.localhost",
  protocol: "http:",
  publicPort: "3042"
});

assert.deepEqual(resolvePreviewOriginConfiguration({
  NURITEO_EXTERNAL_URL: "https://nuriteo.example.com",
  NURITEO_PREVIEW_BASE_DOMAIN: "preview.nuriteo.example.com"
}), {
  status: "disabled",
  code: "PREVIEW_WILDCARD_NOT_READY",
  message: "Preview wildcard DNS and TLS are not ready."
});
assert.equal(resolvePreviewOriginConfiguration({
  NURITEO_EXTERNAL_URL: "http://nuriteo.example.com",
  NURITEO_PREVIEW_BASE_DOMAIN: "preview.nuriteo.example.com",
  NURITEO_PREVIEW_WILDCARD_READY: "true"
}).status, "disabled", "operator acknowledgement must not weaken the HTTPS requirement");
assert.equal(resolvePreviewOriginConfiguration({
  NURITEO_EXTERNAL_URL: "https://nuriteo.example.com",
  NURITEO_PREVIEW_BASE_DOMAIN: "preview.nuriteo.example.com",
  NURITEO_PREVIEW_WILDCARD_READY: "true"
}).status, "enabled");
const nonDefaultPort = resolvePreviewOriginConfiguration({
  NURITEO_EXTERNAL_URL: "https://nuriteo.example.com:8443",
  NURITEO_PREVIEW_BASE_DOMAIN: "preview.nuriteo.example.com",
  NURITEO_PREVIEW_WILDCARD_READY: "true"
});
assert(nonDefaultPort.status === "enabled");
assert.equal(createPreviewOriginUrl(nonDefaultPort, runtimeId, 4173).url, `https://r-${runtimeId}-p4173.preview.nuriteo.example.com:8443/runtime-preview/bootstrap`);

assert(local.status === "enabled");
const preview = createPreviewOriginUrl(local, runtimeId, 4173);
assert.equal(preview.url, `http://r-${runtimeId}-p4173.preview.localhost:3042/runtime-preview/bootstrap`);
assert.deepEqual(parsePreviewHost(`r-${runtimeId}-p4173.preview.localhost`, "preview.localhost"), preview.binding);
for (const hostname of [
  `project-name.r-${runtimeId}-p4173.preview.localhost`,
  `r-${runtimeId}-p0.preview.localhost`,
  `r-${runtimeId}-p65536.preview.localhost`,
  `r-${runtimeId}-p4173.attacker-preview.localhost`,
  `r-${"0".repeat(45)}-p4173.preview.localhost`
]) assert.equal(parsePreviewHost(hostname, "preview.localhost"), null, hostname);
assert.deepEqual(parsePreviewHost(`R-${runtimeId}-P4173.preview.localhost`, "preview.localhost"), preview.binding);

assert.deepEqual(
  parseInternalPreviewUrl(`http://app.localhost:3042/__preview/${projectId}/4173/`, projectId, "http://app.localhost:3042"),
  {
    baseUrl: `http://app.localhost:3042/__preview/${projectId}/4173/`,
    port: 4173,
    projectId
  }
);
assert.throws(
  () => parseInternalPreviewUrl(`http://app.localhost:3042/__preview/019a4a82-1640-7000-8000-000000000002/4173/`, projectId, "http://app.localhost:3042"),
  /invalid internal Preview URL/u
);
assert.throws(
  () => parseInternalPreviewUrl(`http://app.localhost:3042/__preview/${projectId}/4173/?token=secret`, projectId, "http://app.localhost:3042"),
  /invalid internal Preview URL/u
);
for (const attackerUrl of [
  `http://attacker.localhost:3042/__preview/${projectId}/4173/`,
  `https://app.localhost:3042/__preview/${projectId}/4173/`,
  `http://user:password@app.localhost:3042/__preview/${projectId}/4173/`,
  `http://app.localhost:3043/__preview/${projectId}/4173/`
]) assert.throws(() => parseInternalPreviewUrl(attackerUrl, projectId, "http://app.localhost:3042"), /invalid internal Preview URL/u);

const middleware = fs.readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
assert.match(middleware, /matcher: \["\/:path\*"\]/u, "Preview host policy must cover Next internals and public assets");
assert.match(middleware, /return previewErrorResponse\(null, 404\);/u);
assert.match(middleware, /response\.headers\.set\("Cache-Control", "no-store"\)/u);
assert.match(middleware, /Cross-Origin-Resource-Policy", "cross-origin"/u);
assert.match(middleware, /Cross-Origin-Resource-Policy", "same-origin"/u);

const bridge = fs.readFileSync(new URL("../src/runtime/subdomain-preview-bridge.ts", import.meta.url), "utf8");
assert.match(bridge, /MAX_IN_FLIGHT_REQUESTS = 4/u);
assert.match(bridge, /credentials: "omit"/u);
assert.doesNotMatch(bridge, /fetch\(internalUrl,[\s\S]{0,300}headers:/u, "relay fetch must not forward browser credential headers");

const serviceWorker = fs.readFileSync(new URL("../public/runtime-preview/sw.js", import.meta.url), "utf8");
assert.match(serviceWorker, /MAX_PENDING_REQUESTS = 8/u);
const bootstrap = fs.readFileSync(new URL("../public/runtime-preview/bootstrap.js", import.meta.url), "utf8");
assert.match(bootstrap, /await waitForController\(\)/u);

const signingKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const signed = await issueSignedPreviewBinding(signingKey, 4173, 1_700_000_000_000, 5_000);
assert.equal(await verifySignedPreviewBinding(signingKey, signed.runtimeId, 4173, 1_700_000_001_000), "valid");
assert.equal(await verifySignedPreviewBinding(signingKey, signed.runtimeId, 5173, 1_700_000_001_000), "invalid");
const tampered = `${signed.runtimeId.slice(0, -1)}${signed.runtimeId.endsWith("a") ? "b" : "a"}`;
assert.equal(await verifySignedPreviewBinding(signingKey, tampered, 4173, 1_700_000_001_000), "invalid");
assert.equal(await verifySignedPreviewBinding(signingKey, signed.runtimeId, 4173, signed.expiresAt), "expired");
const issued = await Promise.all(Array.from({ length: 1_000 }, () => issueSignedPreviewBinding(signingKey, 4173, 1_700_000_000_000, 5_000)));
assert.equal(new Set(issued.map((item) => item.runtimeId)).size, issued.length, "same-port/same-expiry Preview capabilities must remain unique");
