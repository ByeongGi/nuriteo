import assert from "node:assert/strict";

import { createApiClient, getSetupStatus } from "../src/index.ts";

const baseUrl = requiredEnvironment("NURITEO_CLIENT_TEST_BASE_URL");
const expected = parseBoolean(
  requiredEnvironment("NURITEO_CLIENT_TEST_BOOTSTRAP_REQUIRED")
);
const client = createApiClient({ baseUrl });

const result = await getSetupStatus(client);
assert.deepEqual(result.data, { bootstrapRequired: expected });
assert.equal(result.status, 200);

const raw = await fetch(`${baseUrl}/api/v1/setup/status`);
assert.equal(raw.status, 200);
assert.equal(raw.headers.get("cache-control"), "no-store");
assert.match(raw.headers.get("content-type") ?? "", /^application\/json\b/u);
assert.deepEqual(await raw.json(), { bootstrapRequired: expected });

console.log(`setup status live contract ok (${String(expected)})`);

function parseBoolean(value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("setup fixture expectation must be true or false");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`required fixture variable ${name} is missing`);
  }
  return value;
}
