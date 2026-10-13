import assert from "node:assert/strict";

import {
  createRegistryCredentialStore,
  HostFetcher,
  redactSecrets,
  stripSensitiveHeadersForRedirect
} from "../../browser-host/src/index.ts";

const store = createRegistryCredentialStore();
store.setToken({
  registryOrigin: "https://registry.npmjs.org/react",
  scope: "@acme",
  token: "npm_secret_token"
});
assert.equal(store.authorizationFor("https://registry.npmjs.org/@acme/pkg", "@acme"), "Bearer npm_secret_token");
assert.equal(store.authorizationFor("https://registry.npmjs.org/@other/pkg", "@other"), null);
assert.equal(JSON.stringify(store.snapshot()).includes("npm_secret_token"), false);
assert.equal(JSON.stringify(store.snapshot()).includes("[REDACTED]"), true);

const sameOriginHeaders = stripSensitiveHeadersForRedirect(
  { authorization: "Bearer npm_secret_token", cookie: "sid=secret", "x-safe": "ok" },
  "https://registry.npmjs.org/one",
  "https://registry.npmjs.org/two"
);
assert.equal(sameOriginHeaders.get("authorization"), "Bearer npm_secret_token");
assert.equal(sameOriginHeaders.get("cookie"), "sid=secret");

const crossOriginHeaders = stripSensitiveHeadersForRedirect(
  { authorization: "Bearer npm_secret_token", cookie: "sid=secret", "npm-auth-token": "npm_secret_token", "x-safe": "ok" },
  "https://registry.npmjs.org/one",
  "https://cdn.example/pkg.tgz"
);
assert.equal(crossOriginHeaders.get("authorization"), null);
assert.equal(crossOriginHeaders.get("cookie"), null);
assert.equal(crossOriginHeaders.get("npm-auth-token"), null);
assert.equal(crossOriginHeaders.get("x-safe"), "ok");

const seen = [];
const fetcher = new HostFetcher({
  fetchImpl: async (url, init) => {
    seen.push({
      url,
      authorization: new Headers(init.headers).get("authorization"),
      cookie: new Headers(init.headers).get("cookie"),
      credentials: init.credentials,
      referrerPolicy: init.referrerPolicy,
      safe: new Headers(init.headers).get("x-safe")
    });
    if (url === "https://registry.npmjs.org/pkg") {
      return new Response(null, { status: 302, headers: { location: "https://cdn.example/pkg.tgz" } });
    }
    return new Response("archive", { status: 200 });
  }
});
await fetcher.download("https://registry.npmjs.org/pkg", {
  headers: {
    authorization: store.authorizationFor("https://registry.npmjs.org/pkg", "@acme"),
    cookie: "sid=secret",
    "x-safe": "ok"
  }
});
assert.deepEqual(seen, [
  {
    url: "https://registry.npmjs.org/pkg",
    authorization: "Bearer npm_secret_token",
    cookie: "sid=secret",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    safe: "ok"
  },
  {
    url: "https://cdn.example/pkg.tgz",
    authorization: null,
    cookie: null,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    safe: "ok"
  }
]);

assert.equal(redactSecrets("token=npm_secret_token", ["npm_secret_token"]), "token=[REDACTED]");
store.clear();
assert.deepEqual(store.snapshot(), []);

console.log("browser host credential safety test ok");
