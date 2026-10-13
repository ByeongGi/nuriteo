import assert from "node:assert/strict";

import { forwardOidcNavigation } from "../src/lib/api/collaboration-bff.ts";

const originalFetch = globalThis.fetch;
const originalInternalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  await forwardsValidatedProviderRedirect();
  await forwardsValidatedApplicationCallback();
  await returnsToLocalRecoveryAfterProviderFailure();
  await rejectsUnsafeRedirects();
} finally {
  globalThis.fetch = originalFetch;
  if (originalInternalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalInternalUrl;
}

async function forwardsValidatedProviderRedirect() {
  let received = "";
  globalThis.fetch = async (input, init) => {
    received = String(input);
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 303, headers: [
      ["location", "https://id.example.test/authorize?client_id=nuriteo&state=opaque"],
      ["set-cookie", "__Host-nuriteo_oidc_binding=opaque; Path=/; Secure; HttpOnly; SameSite=Lax"],
      ["set-cookie", "unrelated=secret; Path=/"]
    ] });
  };
  const response = await forwardOidcNavigation(new Request("https://app.example.test/api/v1/auth/oidc/id/begin", { headers: { host: "app.example.test" } }), "/api/v1/auth/oidc/id/begin", "provider");
  assert.equal(received, "http://core.internal:8080/api/v1/auth/oidc/id/begin");
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location") ?? "", /^https:\/\/id\.example\.test\/authorize/u);
  assert.deepEqual(response.headers.getSetCookie(), ["__Host-nuriteo_oidc_binding=opaque; Path=/; Secure; HttpOnly; SameSite=Lax"]);
}

async function forwardsValidatedApplicationCallback() {
  globalThis.fetch = async (_input, init) => {
    assert.match(new Headers(init?.headers).get("cookie") ?? "", /oidc_binding/u);
    return new Response(null, { status: 303, headers: [
      ["location", "/workspaces"],
      ["set-cookie", "__Host-nuriteo_session=opaque; Path=/; Secure; HttpOnly; SameSite=Lax"],
      ["set-cookie", "__Host-nuriteo_csrf=nrt_csrf_opaque; Path=/; Secure; SameSite=Strict"]
    ] });
  };
  const response = await forwardOidcNavigation(new Request("https://app.example.test/callback", { headers: { cookie: "__Host-nuriteo_oidc_binding=opaque", host: "app.example.test" } }), "/api/v1/auth/oidc/id/callback?iss=x&state=y&code=z", "application");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/workspaces");
  assert.equal(response.headers.getSetCookie().length, 2);
}

async function rejectsUnsafeRedirects() {
  globalThis.fetch = async () => new Response(null, { status: 303, headers: { location: "http://attacker.example.test/steal" } });
  const response = await forwardOidcNavigation(new Request("https://app.example.test/begin", { headers: { host: "app.example.test" } }), "/api/v1/auth/oidc/id/begin", "provider");
  assert.equal(response.status, 502);
  assert.equal(response.headers.has("location"), false);
}

async function returnsToLocalRecoveryAfterProviderFailure() {
  globalThis.fetch = async () => Response.json({ detail: "do not expose" }, { status: 401 });
  const response = await forwardOidcNavigation(new Request("https://app.example.test/callback", { headers: { host: "app.example.test" } }), "/api/v1/auth/oidc/id/callback?iss=x&state=y&code=z", "application");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/sign-in?oidc=failed");
  assert.equal(await response.text(), "");
}
