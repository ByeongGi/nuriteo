import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApiError,
  ApiInvalidResponseError,
  ApiTransportError
} from "@nuriteo/api-client";

import {
  classifySignInFailure,
  isExplicitlySignedOut,
  safeRequestReference
} from "../src/lib/api/presentation-error.ts";
import { setupDestination } from "../src/lib/setup-destination.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

testSetupRouting();
testAuthenticationErrorClassification();
testCliOnlySetupContract();
testAccessibleCredentialBoundary();

function testSetupRouting(): void {
  assert.equal(setupDestination(true), "/setup");
  assert.equal(setupDestination(false), "/sign-in");

  const rootPage = read("src/app/page.tsx");
  assert.match(rootPage, /getSetupStatus\(client\)/u);
  assert.match(rootPage, /safeRequestReference\(error\)/u);
  assert.match(rootPage, /setupDestination\(bootstrapRequired\)/u);
}

function testAuthenticationErrorClassification(): void {
  const unauthorized = new ApiError(401, "request-401", undefined);
  const forbidden = new ApiError(403, "request-403", undefined);
  const serverFailure = new ApiError(503, "request-503", undefined);
  const invalidPayload = new ApiInvalidResponseError(200, "request-invalid");

  assert.equal(isExplicitlySignedOut(unauthorized), true);
  assert.equal(isExplicitlySignedOut(forbidden), true);
  assert.equal(isExplicitlySignedOut(serverFailure), false);
  assert.equal(isExplicitlySignedOut(new ApiTransportError()), false);
  assert.equal(classifySignInFailure(unauthorized), "invalid-credentials");
  assert.equal(classifySignInFailure(serverFailure), "service-unavailable");
  assert.equal(classifySignInFailure(invalidPayload), "service-unavailable");
  assert.equal(safeRequestReference(serverFailure), "request-503");
  assert.equal(
    safeRequestReference(new ApiError(503, "unsafe request id", undefined)),
    undefined
  );
}

function testCliOnlySetupContract(): void {
  const setupPage = read("src/app/setup/page.tsx");
  assert.match(setupPage, /docker compose run --rm bootstrap-admin/u);
  assert.match(setupPage, /getSetupStatus\(client\)/u);
  assert.match(setupPage, /redirect\("\/sign-in"\)/u);
  assert.doesNotMatch(setupPage, /createSession|type="password"|BOOTSTRAP_ADMIN_PASSWORD/u);
}

function testAccessibleCredentialBoundary(): void {
  const signInPage = read("src/app/sign-in/page.tsx");
  const form = read("src/app/sign-in/sign-in-form.tsx");

  assert.match(signInPage, /isExplicitlySignedOut\(error\)/u);
  assert.match(signInPage, /redirect\("\/workspaces"\)/u);
  assert.match(form, /<label htmlFor="email">Email<\/label>/u);
  assert.match(form, /<label htmlFor="password">Password<\/label>/u);
  assert.match(form, /autoComplete="username"/u);
  assert.match(form, /autoComplete="current-password"/u);
  assert.match(form, /await createSession\(client, \{ email, password \}\);\s+await getCurrentUser\(client\);/u);
  assert.match(form, /router\.replace\("\/workspaces"\)/u);
  assert.match(form, /passwordInput\.current\.value = ""/u);
  assert.match(form, /role="alert"/u);
  assert.doesNotMatch(form, /localStorage|sessionStorage|URLSearchParams|console\./u);
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}
