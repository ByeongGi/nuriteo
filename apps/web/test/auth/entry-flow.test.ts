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
} from "../../src/lib/api/presentation-error.ts";
import { setupDestination } from "../../src/lib/setup-destination.ts";
import {
  DEFAULT_SIGN_IN_DESTINATION,
  reauthenticationHref,
  safeReturnTo,
  signInHref
} from "../../src/app/(public)/sign-in/return-to.ts";
import {
  clearOidcReturnToCookie,
  issueOidcReturnToCookie,
  readOidcReturnTo
} from "../../src/app/(public)/sign-in/oidc-return-to.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

testSetupRouting();
testAuthenticationErrorClassification();
testCliOnlySetupContract();
testAccessibleCredentialBoundary();
testActivationAndSystemStateContracts();
testSafeReturnTo();
testOidcReturnToCookie();

function testSetupRouting(): void {
  assert.equal(setupDestination(true), "/setup");
  assert.equal(setupDestination(false), "/sign-in");

  const rootPage = read("src/app/page.tsx");
  assert.match(rootPage, /Promise\.allSettled\(\[/u);
  assert.match(rootPage, /getSetupStatus\(client\)/u);
  assert.match(rootPage, /getCurrentUser\(client\)/u);
  assert.match(rootPage, /isExplicitlySignedOut\(currentUserResult\.reason\)/u);
  assert.match(rootPage, /safeRequestReference\(error\)/u);
  assert.match(rootPage, /redirect\("\/setup"\)/u);
  assert.match(rootPage, /redirect\("\/workspaces"\)/u);
  assert.match(rootPage, /<HomeEntry \/>/u);

  const homeEntry = read("src/app/_components/home-entry.tsx");
  assert.match(homeEntry, /href="\/sign-in"/u);
  assert.match(homeEntry, /href="\/examples"/u);
  assert.match(homeEntry, /id="main-content"/u);
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
  const setupPage = read("src/app/(public)/setup/page.tsx");
  assert.match(setupPage, /docker compose run --rm bootstrap-admin/u);
  assert.match(setupPage, /getSetupStatus\(client\)/u);
  assert.match(setupPage, /redirect\("\/sign-in"\)/u);
  assert.doesNotMatch(setupPage, /createSession|type="password"|BOOTSTRAP_ADMIN_PASSWORD/u);
}

function testAccessibleCredentialBoundary(): void {
  const signInPage = read("src/app/(public)/sign-in/page.tsx");
  const form = read("src/app/(public)/sign-in/sign-in-form.tsx");
  const browserClient = read("src/lib/api/browser-client.ts");

  assert.match(signInPage, /isExplicitlySignedOut\(error\)/u);
  assert.match(signInPage, /if \(reauthentication\)/u);
  assert.match(signInPage, /redirect\(returnTo\)/u);
  assert.match(form, /<label[^>]*htmlFor="email"[^>]*>이메일<\/label>/u);
  assert.match(form, /<label[^>]*htmlFor="password"[^>]*>비밀번호<\/label>/u);
  assert.match(form, /autoComplete="username"/u);
  assert.match(form, /autoComplete="current-password"/u);
  assert.match(form, /await createSession\(client, \{ email, password \}\);\s+await getCurrentUser\(client\);/u);
  assert.match(form, /router\.replace\(destination\)/u);
  assert.match(form, /begin\?returnTo=\$\{encodeURIComponent\(destination\)\}/u);
  assert.match(form, /passwordInput\.current\.value = ""/u);
  assert.match(form, /role="alert"/u);
  assert.doesNotMatch(form, /localStorage|sessionStorage|URLSearchParams|console\./u);
  assert.match(browserClient, /REAUTHENTICATION_REQUIRED/u);
  assert.match(browserClient, /window\.location\.assign\(reauthenticationHref\(returnTo\)\)/u);
}

function testActivationAndSystemStateContracts(): void {
  const activation = read("src/app/(public)/activate/activation-form.tsx");
  const systemStates = read("src/design-system/production-shells.stories.tsx");
  const projectsLoading = read("src/app/(authenticated)/projects/loading.tsx");
  const workspacesLoading = read("src/app/(authenticated)/workspaces/loading.tsx");

  assert.match(activation, /activationToken === undefined \? searchParams\.get\("token"\) : activationToken/u);
  assert.match(activation, /if \(token === null \|\| token\.trim\(\)\.length === 0\)/u);
  assert.match(activation, /계정을 활성화할 수 없습니다/u);
  assert.match(systemStates, /<ActivationForm activationToken="storybook-activation-token"/u);
  assert.match(systemStates, /<EntryUnavailable/u);
  assert.match(systemStates, /<ErrorView/u);
  assert.match(systemStates, /<NotFound/u);
  assert.doesNotMatch(systemStates, /<form/u);
  assert.match(projectsLoading, /<WorkspacePageLoading/u);
  assert.match(workspacesLoading, /<WorkspacePageLoading/u);
}

function testSafeReturnTo(): void {
  assert.equal(safeReturnTo("/workspaces/alpha/projects?view=active#recent"), "/workspaces/alpha/projects?view=active#recent");
  assert.equal(safeReturnTo("/mfa"), "/mfa");
  assert.equal(safeReturnTo("https://example.test/steal"), DEFAULT_SIGN_IN_DESTINATION);
  assert.equal(safeReturnTo("//example.test/steal"), DEFAULT_SIGN_IN_DESTINATION);
  assert.equal(safeReturnTo("/\\example.test/steal"), DEFAULT_SIGN_IN_DESTINATION);
  assert.equal(safeReturnTo("/sign-in?returnTo=%2Fsign-in"), DEFAULT_SIGN_IN_DESTINATION);
  assert.equal(safeReturnTo(undefined), DEFAULT_SIGN_IN_DESTINATION);
  assert.equal(signInHref("/projects/alpha/studio"), "/sign-in?returnTo=%2Fprojects%2Falpha%2Fstudio");
  assert.equal(reauthenticationHref("/admin/settings?section=security"), "/sign-in?reauthenticate=1&returnTo=%2Fadmin%2Fsettings%3Fsection%3Dsecurity");
}

function testOidcReturnToCookie(): void {
  const destination = "/admin/settings?section=security";
  const request = new Request("https://nuriteo.example/api/v1/auth/oidc/provider/begin");
  const issued = issueOidcReturnToCookie(request, destination);
  assert.match(issued, /^__Host-nuriteo_oidc_return_to=/u);
  assert.match(issued, /; HttpOnly; SameSite=Lax;/u);
  assert.match(issued, /; Secure$/u);
  const cookiePair = issued.split(";", 1)[0]!;
  const callback = new Request("https://nuriteo.example/api/v1/auth/oidc/provider/callback", {
    headers: { cookie: cookiePair }
  });
  assert.equal(readOidcReturnTo(callback), destination);
  assert.match(clearOidcReturnToCookie(callback), /Max-Age=0; Secure$/u);
  const unsafe = new Request(callback.url, {
    headers: { cookie: "__Host-nuriteo_oidc_return_to=https%3A%2F%2Fevil.example" }
  });
  assert.equal(readOidcReturnTo(unsafe), DEFAULT_SIGN_IN_DESTINATION);
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}
