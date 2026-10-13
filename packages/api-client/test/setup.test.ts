import assert from "node:assert/strict";

import {
  ApiInvalidResponseError,
  ApiResponseTooLargeError,
  createApiClient,
  getSetupStatus
} from "../src/index.ts";

await testSetupStatusContract();
await testMalformedStatusFailsClosed();
await testOversizedStatusFailsAtTheTransportBoundary();

async function testSetupStatusContract(): Promise<void> {
  for (const bootstrapRequired of [true, false]) {
    let receivedUrl: string | undefined;
    let receivedMethod: string | undefined;
    const client = createApiClient({
      fetch: async (input, init) => {
        receivedUrl = String(input);
        receivedMethod = init?.method;
        return Response.json(
          { bootstrapRequired },
          { headers: { "x-request-id": "setup-request" } }
        );
      }
    });
    const response = await getSetupStatus(client);
    assert.equal(receivedUrl, "/api/v1/setup/status");
    assert.equal(receivedMethod, "GET");
    assert.deepEqual(response, {
      data: { bootstrapRequired },
      status: 200,
      requestId: "setup-request"
    });
  }
}

async function testMalformedStatusFailsClosed(): Promise<void> {
  for (const payload of [
    {},
    { bootstrapRequired: "true" },
    { bootstrapRequired: true, email: "must-not-escape@example.test" },
    null,
    []
  ]) {
    const client = createApiClient({ fetch: async () => Response.json(payload) });
    await assert.rejects(
      getSetupStatus(client),
      (error) =>
        error instanceof ApiInvalidResponseError &&
        !String(error).includes("must-not-escape") &&
        !JSON.stringify(error).includes("must-not-escape")
    );
  }

  const wrongStatus = createApiClient({
    fetch: async () => Response.json({ bootstrapRequired: true }, { status: 201 })
  });
  await assert.rejects(getSetupStatus(wrongStatus), ApiInvalidResponseError);
}

async function testOversizedStatusFailsAtTheTransportBoundary(): Promise<void> {
  const client = createApiClient({
    fetch: async () =>
      Response.json({ bootstrapRequired: true, padding: "x".repeat(256) })
  });
  await assert.rejects(
    getSetupStatus(client, { maxResponseBytes: 64 }),
    ApiResponseTooLargeError
  );
}
