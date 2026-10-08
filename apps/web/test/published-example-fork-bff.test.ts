import assert from "node:assert/strict";

import { POST as forkActiveExample } from "../src/app/api/v1/published-examples/[publicId]/forks/route.ts";
import { POST as forkFixedExample } from "../src/app/api/v1/published-examples/[publicId]/versions/[versionNumber]/forks/route.ts";

const PUBLIC_ID = "ExESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA";
const OWNER_ID = "0199ee6c-c777-7000-8000-00000000e001";
const PROJECT_ID = "0199ee6c-c777-7000-8000-00000000e002";
const CSRF = `nrt_csrf_${"f".repeat(43)}`;
const IDEMPOTENCY_KEY = "published-example-fork-contract-0001";
const ORIGIN = "https://nuriteo.example.test";
const previousApiUrl = process.env.NURITEO_INTERNAL_API_URL;
const previousFetch = globalThis.fetch;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core-api:8080";
  await forwardsOnlyTheAuthenticatedForkBoundary();
  await keepsTheFixedVersionInTheUpstreamPath();
  await rejectsMissingOrNonExactBrowserProofs();
} finally {
  globalThis.fetch = previousFetch;
  if (previousApiUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = previousApiUrl;
}

async function forwardsOnlyTheAuthenticatedForkBoundary(): Promise<void> {
  let upstreamUrl = "";
  let upstreamInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input);
    upstreamInit = init;
    return forkResponse(false, 201);
  };

  const response = await forkActiveExample(forkRequest(), {
    params: Promise.resolve({ publicId: PUBLIC_ID })
  });
  const headers = new Headers(upstreamInit?.headers);

  assert.equal(response.status, 201);
  assert.equal(upstreamUrl, `http://core-api:8080/api/v1/published-examples/${PUBLIC_ID}/forks`);
  assert.equal(upstreamInit?.credentials, "omit");
  assert.equal(upstreamInit?.redirect, "error");
  assert.equal(headers.get("cookie"), "nuriteo_dev_session=browser-session; nuriteo_dev_csrf=browser-csrf");
  assert.equal(headers.get("origin"), ORIGIN);
  assert.equal(headers.get("x-csrf-token"), CSRF);
  assert.equal(headers.get("idempotency-key"), IDEMPOTENCY_KEY);
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("x-private-project-token"), false);
  assert.deepEqual(JSON.parse(Buffer.from(upstreamInit?.body as ArrayBuffer).toString("utf8")), {
    destinationOwner: { ownerType: "user", ownerId: OWNER_ID },
    slug: "safe-fork",
    name: "Safe fork"
  });
  assert.equal(response.headers.get("location"), projectLocation());
}

async function keepsTheFixedVersionInTheUpstreamPath(): Promise<void> {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return forkResponse(true, 200);
  };
  const response = await forkFixedExample(forkRequest("/versions/3/forks"), {
    params: Promise.resolve({ publicId: PUBLIC_ID, versionNumber: "3" })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(urls, [
    `http://core-api:8080/api/v1/published-examples/${PUBLIC_ID}/versions/3/forks`
  ]);
}

async function rejectsMissingOrNonExactBrowserProofs(): Promise<void> {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return forkResponse(false, 201);
  };
  for (const headers of [
    { origin: "https://attacker.example.test", "x-csrf-token": CSRF, "idempotency-key": IDEMPOTENCY_KEY },
    { origin: ORIGIN, "idempotency-key": IDEMPOTENCY_KEY },
    { origin: ORIGIN, "x-csrf-token": CSRF }
  ]) {
    const response = await forkActiveExample(forkRequest("/forks", headers), {
      params: Promise.resolve({ publicId: PUBLIC_ID })
    });
    assert.ok(response.status === 403 || response.status === 428);
  }
  assert.equal(fetches, 0);
}

function forkRequest(
  suffix = "/forks",
  overrides: Record<string, string> = {}
): Request {
  const headers = new Headers({
    authorization: "Bearer must-not-cross-the-bff",
    cookie: "nuriteo_dev_session=browser-session; nuriteo_dev_csrf=browser-csrf",
    "content-type": "application/json",
    host: "nuriteo.example.test",
    "idempotency-key": IDEMPOTENCY_KEY,
    origin: ORIGIN,
    "x-csrf-token": CSRF,
    "x-private-project-token": "must-not-cross-the-bff"
  });
  for (const [name, value] of Object.entries(overrides)) headers.set(name, value);
  if (!("x-csrf-token" in overrides) && Object.keys(overrides).length > 0) {
    headers.delete("x-csrf-token");
  }
  if (!("idempotency-key" in overrides) && Object.keys(overrides).length > 0) {
    headers.delete("idempotency-key");
  }
  return new Request(`${ORIGIN}/api/v1/published-examples/${PUBLIC_ID}${suffix}`, {
    body: JSON.stringify({
      destinationOwner: { ownerType: "user", ownerId: OWNER_ID },
      slug: "safe-fork",
      name: "Safe fork"
    }),
    headers,
    method: "POST"
  });
}

function forkResponse(idempotentRetry: boolean, status: number): Response {
  return Response.json({
    project: {
      id: PROJECT_ID,
      ownerType: "user",
      ownerId: OWNER_ID,
      slug: "safe-fork",
      name: "Safe fork",
      state: "active",
      version: 1,
      createdAt: "2026-10-08T00:00:00Z",
      updatedAt: "2026-10-08T00:00:00Z"
    },
    sourceVersionNumber: 3,
    idempotentRetry
  }, { headers: { location: projectLocation() }, status });
}

function projectLocation(): string {
  return `/api/v1/workspaces/users/${OWNER_ID}/projects/${PROJECT_ID}`;
}
