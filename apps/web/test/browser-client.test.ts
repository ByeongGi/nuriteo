import assert from "node:assert/strict";

import {
  ApiResponseTooLargeError
} from "@nuriteo/api-client";

import { createBrowserApiClient } from "../src/lib/api/browser-client.ts";

await testSameOriginClient();
await testBoundedResponseContract();

async function testSameOriginClient(): Promise<void> {
  let receivedUrl: string | undefined;
  let receivedInit: RequestInit | undefined;
  const client = createBrowserApiClient({
    fetch: async (input, init) => {
      receivedUrl = String(input);
      receivedInit = init;
      return Response.json({ version: "test" });
    }
  });
  const independentClient = createBrowserApiClient({
    fetch: async () => Response.json({ version: "independent" })
  });

  await client.get("/version");

  assert.notEqual(client, independentClient);
  assert.equal(receivedUrl, "/api/v1/version");
  assert.equal(receivedInit?.credentials, "same-origin");
}

async function testBoundedResponseContract(): Promise<void> {
  const client = createBrowserApiClient({
    fetch: async () => new Response("oversized"),
    maxResponseBytes: 4
  });

  await assert.rejects(client.get("/version"), ApiResponseTooLargeError);
}
