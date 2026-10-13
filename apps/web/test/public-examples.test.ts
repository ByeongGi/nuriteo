import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getPublicPublishedExample,
  publicPublishedExampleContentPath
} from "@nuriteo/api-client";

import { createPublicApiClient } from "../src/lib/api/public-server-policy.ts";
import {
  publicIdPathSegment,
  publicVersionPathSegment
} from "../src/lib/published-example-path.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_ID = "ExESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA";

await testCookieFreePublicClient();
await testCookieFreePublicBinaryFetch();
testPublicRouteValidation();
testReadOnlyPublicExperienceBoundary();

async function testCookieFreePublicClient(): Promise<void> {
  let receivedUrl = "";
  let receivedInit: RequestInit | undefined;
  const client = createPublicApiClient({
    fetch: async (input, init) => {
      receivedUrl = String(input);
      receivedInit = init;
      return Response.json({
        name: "Safe example",
        publicId: PUBLIC_ID,
        publishedAt: "2026-10-08T00:00:00Z",
        versionNumber: 3,
        visibility: "public"
      });
    },
    internalApiUrl: "http://core-api:8080"
  });

  await client.get(`/published-examples/${PUBLIC_ID}`, {
    headers: {
      authorization: "Bearer must-not-cross-public-boundary",
      cookie: "session=must-not-cross-public-boundary",
      "x-csrf-token": "must-not-cross-public-boundary"
    }
  });
  await getPublicPublishedExample(client, { publicId: PUBLIC_ID });

  assert.equal(receivedUrl, `http://core-api:8080/api/v1/published-examples/${PUBLIC_ID}`);
  assert.equal(receivedInit?.cache, "no-store");
  assert.equal(receivedInit?.credentials, "omit");
  assert.equal(receivedInit?.redirect, "error");
  assert.deepEqual([...new Headers(receivedInit?.headers).entries()], [
    ["accept", "application/json, application/problem+json, text/plain"]
  ]);
}

async function testCookieFreePublicBinaryFetch(): Promise<void> {
  let receivedUrl = "";
  let receivedInit: RequestInit | undefined;
  const { fetchPublicBinary } = await import("../src/lib/api/public-server-policy.ts");
  const path = publicPublishedExampleContentPath({ publicId: PUBLIC_ID, versionNumber: 3 });
  await fetchPublicBinary(
    {
      fetch: async (input, init) => {
        receivedUrl = String(input);
        receivedInit = init;
        return new Response(new Uint8Array([1]));
      },
      internalApiUrl: "http://core-api:8080"
    },
    path
  );
  assert.equal(
    receivedUrl,
    `http://core-api:8080/api/v1/published-examples/${PUBLIC_ID}/versions/3/content`
  );
  assert.equal(receivedInit?.credentials, "omit");
  assert.equal(receivedInit?.redirect, "error");
  assert.deepEqual([...new Headers(receivedInit?.headers).entries()], [
    ["accept", "application/vnd.nuriteo.published-project-bundle"]
  ]);
}

function testPublicRouteValidation(): void {
  assert.equal(publicIdPathSegment(PUBLIC_ID), PUBLIC_ID);
  assert.equal(publicIdPathSegment(`${PUBLIC_ID.slice(0, -1)}B`), undefined);
  assert.equal(publicVersionPathSegment("1"), 1);
  assert.equal(publicVersionPathSegment("0001"), undefined);
  assert.equal(publicVersionPathSegment("0"), undefined);
  assert.equal(publicVersionPathSegment("9007199254740992"), undefined);
}

function testReadOnlyPublicExperienceBoundary(): void {
  const gallery = read("src/app/examples/page.tsx");
  const detail = read("src/app/examples/[publicId]/page.tsx");
  const version = read("src/app/examples/[publicId]/versions/[versionNumber]/page.tsx");
  const shell = read("src/app/examples/_components/read-only-example-shell.tsx");
  const forkForm = read("src/app/examples/_components/fork-example-form.tsx");
  const publicClient = read("src/lib/api/public-server-client.ts");
  const workspaceRoute = read("src/app/api/v1/me/workspaces/route.ts");

  assert.match(gallery, /listPublicPublishedExamples\(createPublicServerApiClient\(\)/u);
  assert.match(detail, /getPublicPublishedExample\(createPublicServerApiClient\(\)/u);
  assert.match(version, /getPublicPublishedExampleVersion/u);
  assert.match(shell, /Read-only/u);
  assert.match(shell, /Fixed snapshot/u);
  assert.match(shell, /Download sanitized archive/u);
  assert.match(shell, /ForkExampleForm/u);
  assert.match(forkForm, /getCurrentWorkspaces/u);
  assert.match(forkForm, /forkPublishedExample/u);
  assert.match(forkForm, /readCsrfCredential/u);
  assert.match(forkForm, /published-example-fork-\$\{crypto\.randomUUID\(\)\}/u);
  assert.match(forkForm, /source access, Git connections, or environment values/u);
  assert.match(shell, /\/api\/v1\/published-examples\/\$\{example\.publicId\}\/versions\/\$\{example\.versionNumber\}\/content/u);
  assert.doesNotMatch(`${gallery}\n${detail}\n${version}\n${shell}`, /ProjectIdeShell|createServerApiClient|cookies\(|headers\(/u);
  assert.doesNotMatch(publicClient, /next\/headers|next\/cookies|createServerApiClient/u);
  assert.match(workspaceRoute, /path: "\/api\/v1\/me\/workspaces"/u);
  assert.match(workspaceRoute, /requireCsrf: false/u);

  for (const route of [
    "src/app/api/v1/published-examples/route.ts",
    "src/app/api/v1/published-examples/[publicId]/route.ts",
    "src/app/api/v1/published-examples/[publicId]/versions/[versionNumber]/route.ts",
    "src/app/api/v1/published-examples/[publicId]/content/route.ts",
    "src/app/api/v1/published-examples/[publicId]/versions/[versionNumber]/content/route.ts"
  ]) {
    const source = read(route);
    assert.doesNotMatch(source, /forwardCollaborationMutation|createServerApiClient/u);
  }

  for (const route of [
    "src/app/api/v1/published-examples/[publicId]/forks/route.ts",
    "src/app/api/v1/published-examples/[publicId]/versions/[versionNumber]/forks/route.ts"
  ]) {
    const source = read(route);
    assert.match(source, /forwardCollaborationMutation/u);
    assert.match(source, /requireCsrf: true/u);
    assert.match(source, /withIdempotencyKey: true/u);
    assert.match(source, /commitOutcomeUnknown: true/u);
  }
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}
