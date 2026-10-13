import assert from "node:assert/strict";

import {
  exactPublishedExamplePath,
  forwardPublishedExampleRequest,
  publishedExampleCollectionPath,
  publishedExampleItemPath
} from "../src/lib/api/published-example-management-bff.ts";

const OWNER_ID = "0199ee6c-c777-7000-8000-000000006001";
const PROJECT_ID = "0199ee6c-c777-7000-8000-000000006002";
const EXAMPLE_ID = "0199ee6c-c777-7000-8000-000000006003";
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  const collection = publishedExampleCollectionPath("organizations", OWNER_ID, PROJECT_ID);
  assert.equal(
    collection,
    `/api/v1/workspaces/organizations/${OWNER_ID}/projects/${PROJECT_ID}/published-examples`
  );
  assert.equal(
    publishedExampleItemPath("organizations", OWNER_ID, PROJECT_ID, EXAMPLE_ID, "versions"),
    `${collection}/${EXAMPLE_ID}/versions`
  );
  assert.equal(publishedExampleItemPath("organizations", OWNER_ID, PROJECT_ID, "unsafe"), undefined);
  assert.equal(
    exactPublishedExamplePath(new Request(`https://nuriteo.test${collection}`), collection),
    collection
  );
  assert.equal(
    exactPublishedExamplePath(new Request(`https://nuriteo.test${collection}?unsafe=1`), collection),
    undefined
  );

  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  let received: { init: RequestInit | undefined; url: string } | undefined;
  globalThis.fetch = async (input, init) => {
    received = { init, url: String(input) };
    return Response.json({ ok: true }, {
      headers: { location: `${collection}/${EXAMPLE_ID}` },
      status: 201
    });
  };
  const created = await forwardPublishedExampleRequest(mutation(collection!, "POST", "{}"), {
    createLocationPrefix: collection!,
    method: "POST",
    path: collection!,
    withBody: true
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("location"), `${collection}/${EXAMPLE_ID}`);
  assert.equal(received?.url, `http://core.internal:8080${collection}`);
  assert.equal(new Headers(received?.init?.headers).get("x-csrf-token"), "csrf-safe");

  const item = publishedExampleItemPath("organizations", OWNER_ID, PROJECT_ID, EXAMPLE_ID)!;
  globalThis.fetch = async (_input, init) => {
    received = { init, url: String(_input) };
    return Response.json({ ok: true }, {
      headers: { etag: '"published-example-v2"' }
    });
  };
  const updated = await forwardPublishedExampleRequest(
    mutation(item, "PATCH", JSON.stringify({ visibility: "public" }), '"published-example-v1"'),
    { method: "PATCH", path: item, withBody: true, withEtag: true }
  );
  assert.equal(updated.status, 200);
  assert.equal(new Headers(received?.init?.headers).get("if-match"), '"published-example-v1"');
  assert.equal(updated.headers.get("etag"), '"published-example-v2"');

  const rejected = await forwardPublishedExampleRequest(
    mutation(item, "PATCH", "{}", 'W/"published-example-v1"'),
    { method: "PATCH", path: item, withBody: true, withEtag: true }
  );
  assert.equal(rejected.status, 428);
  assert.equal((await rejected.json() as { code: string }).code, "BFF_PRECONDITION_REQUIRED");
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

function mutation(path: string, method: string, body: string, etag?: string): Request {
  return new Request(`https://nuriteo.test${path}`, {
    body,
    headers: {
      "content-type": "application/json",
      host: "nuriteo.test",
      ...(etag === undefined ? {} : { "if-match": etag }),
      origin: "https://nuriteo.test",
      "x-csrf-token": "csrf-safe"
    },
    method
  });
}
