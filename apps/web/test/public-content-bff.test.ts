import assert from "node:assert/strict";

import { publicExampleContentResponse } from "../src/lib/api/published-example-bff.ts";

const PUBLIC_ID = "ExESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA";
const CONTENT_ETAG = `"published-content-v3-${"A".repeat(43)}"`;
const previousApiUrl = process.env.NURITEO_INTERNAL_API_URL;
const previousFetch = globalThis.fetch;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core-api:8080";
  await proxiesOneBoundedCookieFreeBundle();
  await rejectsRangeWithoutContactingCore();
  await rejectsMalformedUpstreamBoundary();
} finally {
  globalThis.fetch = previousFetch;
  if (previousApiUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = previousApiUrl;
}

async function proxiesOneBoundedCookieFreeBundle(): Promise<void> {
  let upstreamUrl = "";
  let upstreamInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input);
    upstreamInit = init;
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "content-length": "3",
        "content-type": "application/vnd.nuriteo.published-project-bundle",
        "cross-origin-resource-policy": "same-origin",
        etag: CONTENT_ETAG,
        "set-cookie": "must-not-cross-the-public-boundary=1",
        "x-content-type-options": "nosniff"
      }
    });
  };
  const response = await publicExampleContentResponse(
    new Request(`https://app.example/api/v1/published-examples/${PUBLIC_ID}/content`, {
      headers: { authorization: "Bearer private", cookie: "private=1" }
    }),
    PUBLIC_ID,
    "3"
  );
  assert.equal(
    upstreamUrl,
    `http://core-api:8080/api/v1/published-examples/${PUBLIC_ID}/versions/3/content`
  );
  assert.equal(upstreamInit?.credentials, "omit");
  assert.deepEqual([...new Headers(upstreamInit?.headers).entries()], [
    ["accept", "application/vnd.nuriteo.published-project-bundle"]
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
}

async function rejectsRangeWithoutContactingCore(): Promise<void> {
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response();
  };
  const response = await publicExampleContentResponse(
    new Request(`https://app.example/api/v1/published-examples/${PUBLIC_ID}/content`, {
      headers: { range: "bytes=0-1" }
    }),
    PUBLIC_ID
  );
  assert.equal(response.status, 416);
  assert.equal(fetched, false);
}

async function rejectsMalformedUpstreamBoundary(): Promise<void> {
  globalThis.fetch = async () => new Response(new Uint8Array([1]), {
    headers: {
      "content-length": "1",
      "content-type": "text/html",
      "cross-origin-resource-policy": "same-origin",
      etag: CONTENT_ETAG,
      "x-content-type-options": "nosniff"
    }
  });
  const response = await publicExampleContentResponse(
    new Request(`https://app.example/api/v1/published-examples/${PUBLIC_ID}/content`),
    PUBLIC_ID
  );
  assert.equal(response.status, 502);
}
