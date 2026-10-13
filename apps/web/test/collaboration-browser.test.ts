import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
  createSecretSafeOutputDiagnostics,
  secretSafeFailureCategory
} from "./secret-safe-output.ts";
import type { OutputStreamName } from "./secret-safe-output.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneWeb = path.join(webRoot, ".next/standalone/apps/web");
const serverEntry = path.join(standaloneWeb, "server.js");
const adminId = "0199ee6c-c777-7000-8000-000000009001";
const inviteeId = "0199ee6c-c777-7000-8000-000000009101";
const organizationId = "0199ee6c-c777-7000-8000-000000009201";
const activationId = "0199ee6c-c777-7000-8000-000000009301";
const activationToken = `nrt_inv_${"a".repeat(43)}`;
const csrfToken = `nrt_csrf_${"c".repeat(43)}`;
const bmpUnicodeEmail = "사용자@example.test";
const astralUnicodeEmail = `${"😀".repeat(313)}@x.test`;
const now = "2026-10-04T00:00:00.000Z";
const later = "2026-10-11T00:00:00.000Z";

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
assert.equal(Array.from(astralUnicodeEmail).length, 320);
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), {
  force: true,
  recursive: true
});

let publicOrigin = "http://127.0.0.1";
let activated = false;
let organizationCreated = false;
let invitationSequence = 0;
let activationIssueCount = 0;
let memberDeleteCount = 0;
let memberRoleChangeCount = 0;
let organizationIssueCount = 0;
let organizationReissueCount = 0;
let organizationRevokeCount = 0;
let malformedAcceptOnce = false;
let malformedDeclineOnce = false;
let observedIfMatch: string | undefined;
const observedUnavailableEmails: string[] = [];
const organizationInvitations: OrganizationInvitation[] = [];
const members: OrganizationMember[] = [{ userId: adminId, displayName: "Instance Administrator", role: "owner" }];
const observedMutationCookies: string[] = [];
const forbiddenServerValues = new Set([
  activationToken,
  csrfToken,
  "correct horse battery staple",
  "nuriteo_dev_session=admin",
  "nuriteo_dev_session=invitee"
]);
const serverOutput = createSecretSafeOutputDiagnostics(forbiddenServerValues);
let journeyStage: CollaborationJourneyStage = "launch-browser";

function addForbiddenServerValue(value: string): void {
  forbiddenServerValues.add(value);
  serverOutput.add(value);
}

const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  const session = sessionFrom(request.headers.cookie);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "collaboration-browser-request");

  if (request.method === "POST" && requestPath === "/api/v1/auth/activation") {
    const body = await jsonBody(request);
    if (body.token !== activationToken || body.email !== "invitee@example.test") {
      return sendProblem(response, 410, "INVITATION_UNUSABLE");
    }
    activated = true;
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === "POST" && requestPath === "/api/v1/auth/sessions") {
    const body = await jsonBody(request);
    if (!activated || body.email !== "invitee@example.test") {
      return sendProblem(response, 401, "AUTHENTICATION_FAILED");
    }
    response.statusCode = 204;
    response.setHeader("set-cookie", [
      "nuriteo_dev_session=invitee; Path=/; HttpOnly; SameSite=Lax",
      `nuriteo_dev_csrf=${csrfToken}; Path=/; SameSite=Lax`
    ]);
    response.end();
    return;
  }

  if (session === undefined) return sendProblem(response, 401, "AUTHENTICATION_REQUIRED");
  if (request.method !== "GET") observedMutationCookies.push(`${requestPath}:${session}`);
  if (request.method !== "GET" && requestPath !== "/api/v1/auth/sessions") {
    assert.equal(request.headers["x-csrf-token"], csrfToken);
  }

  if (request.method === "GET" && requestPath === "/api/v1/me") {
    return sendJson(response, currentUser(session));
  }
  if (request.method === "GET" && requestPath === "/api/v1/me/workspaces") {
    return sendJson(response, { workspaces: workspaces(session) });
  }
  if (request.method === "GET" && requestPath === "/api/v1/admin/activation-invitations") {
    if (session !== "admin") return sendProblem(response, 403, "FORBIDDEN");
    return sendJson(response, { items: activated ? [{ ...activationRecord(), status: "accepted", accepted_at: now }] : [activationRecord()] });
  }
  if (request.method === "POST" && requestPath === "/api/v1/admin/activation-invitations") {
    if (session !== "admin") return sendProblem(response, 403, "FORBIDDEN");
    const body = await jsonBody(request);
    if (body.email === "mail-queued@example.test") {
      return sendJson(response, {
        ...activationRecord(),
        email: body.email,
        id: "0199ee6c-c777-7000-8000-000000009302",
        delivery: "email_queued",
        activation_url: null
      }, 201);
    }
    activationIssueCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 75));
    return sendJson(response, { ...activationRecord(), delivery: "copy_once", activation_url: `${publicOrigin}/activate?token=${activationToken}` }, 201);
  }
  if (request.method === "POST" && requestPath === "/api/v1/organizations") {
    if (session !== "admin") return sendProblem(response, 403, "FORBIDDEN");
    organizationCreated = true;
    response.setHeader("etag", '"org-v1"');
    response.setHeader("location", `/api/v1/organizations/${organizationId}`);
    return sendJson(response, organization(), 201);
  }
  if (request.method === "GET" && requestPath === `/api/v1/organizations/${organizationId}`) {
    response.setHeader("etag", '"org-v1"');
    return sendJson(response, organization());
  }
  if (request.method === "GET" && requestPath === `/api/v1/organizations/${organizationId}/members`) {
    return sendJson(response, { items: visibleMemberPage() });
  }
  if (request.method === "GET" && requestPath === `/api/v1/organizations/${organizationId}/invitations`) {
    if (session !== "admin") return sendProblem(response, 403, "FORBIDDEN");
    return sendJson(response, { items: organizationInvitations });
  }
  if (request.method === "POST" && requestPath === `/api/v1/organizations/${organizationId}/invitations`) {
    if (session !== "admin") return sendProblem(response, 403, "FORBIDDEN");
    const body = await jsonBody(request);
    assert.deepEqual(Object.keys(body).toSorted(), ["email", "role"]);
    if (
      body.email === "unavailable@example.test" ||
      body.email === bmpUnicodeEmail ||
      body.email === astralUnicodeEmail
    ) {
      observedUnavailableEmails.push(body.email);
      return sendProblem(response, 404, "ORGANIZATION_NOT_FOUND");
    }
    assert.ok(body.role === "member" || body.role === "owner");
    if (body.email === "mail-queued@example.test") {
      const invitation = newOrganizationInvitation(body.role);
      return sendJson(response, {
        ...invitation,
        delivery: "email_queued",
        acceptUrl: null
      }, 201);
    }
    assert.equal(body.email, "invitee@example.test");
    return issueOrganizationInvitation(response, body.role);
  }
  if (request.method === "PATCH" && requestPath === `/api/v1/organizations/${organizationId}`) {
    observedIfMatch = request.headers["if-match"];
    return sendProblem(response, 412, "ORGANIZATION_VERSION_STALE");
  }
  const memberMutation = requestPath.match(new RegExp(`^/api/v1/organizations/${organizationId}/members/([^/]+)$`, "u"));
  if (memberMutation?.[1] && request.method === "PATCH") {
    const body = await jsonBody(request);
    const member = members.find((item) => item.userId === memberMutation[1]);
    assert.ok(member);
    member.role = body.role === "owner" ? "owner" : "member";
    memberRoleChangeCount += 1;
    response.statusCode = 204;
    response.end();
    return;
  }
  if (memberMutation?.[1] && request.method === "DELETE") {
    const index = members.findIndex((item) => item.userId === memberMutation[1]);
    assert.notEqual(index, -1);
    members.splice(index, 1);
    memberDeleteCount += 1;
    response.statusCode = 204;
    response.end();
    return;
  }
  const reissue = requestPath.match(new RegExp(`^/api/v1/organizations/${organizationId}/invitations/([^/]+)/reissue$`, "u"));
  if (request.method === "POST" && reissue?.[1]) {
    const existing = organizationInvitations.find((item) => item.id === reissue[1]);
    assert.ok(existing);
    const body = await jsonBody(request);
    assert.deepEqual(body, { role: existing.proposedRole });
    const replacement = newOrganizationInvitation(existing.proposedRole);
    existing.status = "superseded";
    existing.supersededAt = now;
    existing.replacementId = replacement.id;
    organizationInvitations.push(replacement);
    organizationReissueCount += 1;
    return sendJson(response, issuedOrganizationInvitation(replacement));
  }
  const revoke = requestPath.match(new RegExp(`^/api/v1/organizations/${organizationId}/invitations/([^/]+)$`, "u"));
  if (request.method === "DELETE" && revoke?.[1]) {
    const existing = organizationInvitations.find((item) => item.id === revoke[1]);
    assert.ok(existing);
    if (existing.status !== "pending") return sendProblem(response, 409, "INVITATION_UNUSABLE");
    existing.status = "revoked";
    existing.revokedAt = now;
    organizationRevokeCount += 1;
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method === "POST" && requestPath === "/api/v1/me/organization-invitations/accept") {
    assert.equal(session, "invitee");
    const body = await jsonBody(request);
    const existing = organizationInvitations.find((item) => invitationToken(item) === body.token);
    if (!existing || existing.status !== "pending") return sendProblem(response, 410, "INVITATION_UNUSABLE");
    if (malformedAcceptOnce) {
      malformedAcceptOnce = false;
      return sendJson(response, existing);
    }
    existing.status = "accepted";
    existing.acceptedAt = now;
    members.push({ userId: inviteeId, displayName: "Invited Teammate", role: existing.proposedRole });
    return sendJson(response, existing);
  }
  if (request.method === "POST" && requestPath === "/api/v1/me/organization-invitations/decline") {
    assert.equal(session, "invitee");
    const body = await jsonBody(request);
    const existing = organizationInvitations.find((item) => invitationToken(item) === body.token);
    if (!existing || existing.status !== "pending") return sendProblem(response, 410, "INVITATION_UNUSABLE");
    if (malformedDeclineOnce) {
      malformedDeclineOnce = false;
      return sendJson(response, {
        ...existing,
        acceptedAt: now,
        status: "accepted"
      });
    }
    existing.status = "declined";
    existing.declinedAt = now;
    return sendJson(response, existing);
  }

  response.statusCode = 404;
  response.end();
});

await listen(core);
const coreAddress = core.address();
assert.ok(coreAddress && typeof coreAddress !== "string");
const standalone = await startStandaloneWeb(coreAddress.port);
const web = standalone.child;
publicOrigin = standalone.origin;

try {
  journeyStage = "launch-browser";
  const browser = await chromium.launch({ headless: true });
  try {
    journeyStage = "bootstrap-admin";
    const admin = await browser.newContext();
    await admin.addCookies([
      { name: "nuriteo_dev_session", value: "admin", url: publicOrigin },
      { name: "nuriteo_dev_csrf", value: csrfToken, url: publicOrigin }
    ]);
    const adminPage = await admin.newPage();
    await adminPage.goto(`${publicOrigin}/admin/invitations`, { waitUntil: "networkidle" });
    await adminPage.getByLabel("Invitee email").fill("mail-queued@example.test");
    await adminPage.getByRole("button", { name: "Issue invitation" }).click();
    await adminPage.getByRole("status").filter({ hasText: "activation email is queued" }).waitFor();
    assert.equal(await adminPage.locator("output").count(), 0);
    await adminPage.getByLabel("Invitee email").fill("invitee@example.test");
    await adminPage.locator("form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    const activationOutput = adminPage.locator("output");
    await activationOutput.waitFor();
    assert.equal(activationIssueCount, 1);
    const activationUrl = await activationOutput.textContent();
    assert.ok(activationUrl?.includes("/activate?token=nrt_inv_"));
    await adminPage.getByRole("button", { name: "Clear link" }).click();
    assert.equal(await adminPage.locator("output").count(), 0);

    const invitee = await browser.newContext();
    const inviteePage = await invitee.newPage();
    const inviteeApiResponses: string[] = [];
    inviteePage.on("response", (response) => {
      if (response.url().includes("/api/v1/")) {
        inviteeApiResponses.push(`${response.status()} ${response.url()}`);
      }
    });
    journeyStage = "activate-invitee";
    await inviteePage.goto(activationUrl!, { waitUntil: "networkidle" });
    await inviteePage.getByLabel("Email").fill("invitee@example.test");
    await inviteePage.getByLabel("Display name").fill("Invited Teammate");
    await inviteePage.getByLabel("Password").fill("correct horse battery staple");
    await inviteePage.getByRole("button", { name: "Activate account" }).click();
    await Promise.race([
      inviteePage.waitForURL("**/sign-in?activated=1"),
      inviteePage.locator(".form-error").waitFor().then(async () => {
        throw new Error(`activation failed safely: ${await inviteePage.locator(".form-error").textContent()}; ${inviteeApiResponses.join(", ")}`);
      })
    ]);
    assert.equal(inviteePage.url().includes("token="), false);
    journeyStage = "authenticate-invitee";
    await inviteePage.getByLabel("Email").fill("invitee@example.test");
    await inviteePage.getByLabel("Password").fill("correct horse battery staple");
    await inviteePage.getByRole("button", { name: "Sign in" }).click();
    await inviteePage.waitForURL("**/workspaces");
    await inviteePage.getByText("Invitee Personal", { exact: true }).waitFor();
    assert.equal(await inviteePage.getByText("Alpha Organization", { exact: true }).count(), 0);
    await inviteePage.goto(`${publicOrigin}/admin/invitations`, { waitUntil: "networkidle" });
    await inviteePage.getByRole("heading", { name: "Administrator access required" }).waitFor();

    journeyStage = "create-organization";
    await adminPage.goto(`${publicOrigin}/organizations`, { waitUntil: "networkidle" });
    await adminPage.getByLabel("Slug").fill("alpha");
    await adminPage.getByLabel("Display name").fill("Alpha Organization");
    await adminPage.getByRole("button", { name: "Create Organization" }).click();
    await waitForCondition(() => organizationCreated);
    try {
      await adminPage.waitForURL(`**/organizations?organization=${organizationId}`);
    } catch {
      throw new Error(`Organization was created but navigation was not rendered: ${adminPage.url()} ${await adminPage.locator("body").innerText()}`);
    }
    assert.equal(await adminPage.getByRole("heading", { name: "Invite member" }).count(), 1);
    await adminPage.getByLabel("Display name").fill("Alpha Organization Renamed");
    await adminPage.getByRole("button", { name: "Save name" }).click();
    await adminPage.getByRole("alert").filter({ hasText: "Reload the latest version" }).waitFor();
    assert.equal(observedIfMatch, '"org-v1"');
    journeyStage = "validate-invitation-form";
    const inviteeEmail = adminPage.getByLabel("Invitee email");
    assert.equal(await inviteeEmail.getAttribute("type"), "text");
    assert.equal(await inviteeEmail.getAttribute("inputmode"), "email");
    assert.equal(await inviteeEmail.evaluate((input: HTMLInputElement) => input.maxLength), -1);
    assert.equal(await inviteeEmail.getAttribute("aria-describedby"), "organization-invitation-email-help");
    await adminPage.getByText("Enter the existing account email using 3 to 320 Unicode characters.", { exact: true }).waitFor();
    assert.equal(await adminPage.getByLabel("Invitee user ID").count(), 0);

    const legacyStatus = await adminPage.evaluate(async ({ csrfToken: csrf, inviteeId: userId, organizationId: id }) => {
      const response = await fetch(`/api/v1/organizations/${id}/invitations`, {
        body: JSON.stringify({ email: "invitee@example.test", inviteeUserId: userId, role: "member" }),
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        method: "POST"
      });
      return response.status;
    }, { csrfToken, inviteeId, organizationId });
    assert.equal(legacyStatus, 400);
    assert.equal(organizationIssueCount, 0);

    journeyStage = "validate-client-rejection";
    await adminPage.reload({ waitUntil: "networkidle" });
    let invitationBffRequestCount = 0;
    adminPage.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith(`/api/v1/organizations/${organizationId}/invitations`)
      ) {
        invitationBffRequestCount += 1;
      }
    });
    for (const invalidKind of ["too-long", "control"] as const) {
      const requestsBefore = invitationBffRequestCount;
      await adminPage.locator('input[name="email"]').evaluate((input: HTMLInputElement, kind) => {
        input.value = kind === "too-long"
          ? "x".repeat(321)
          : `x${String.fromCharCode(1)}@example.test`;
        input.form?.requestSubmit();
      }, invalidKind);
      await adminPage.getByRole("alert").filter({ hasText: "The request could not be completed" }).waitFor();
      await adminPage.waitForTimeout(25);
      assert.equal(invitationBffRequestCount, requestsBefore);
      assert.equal(organizationIssueCount, 0);
      await adminPage.reload({ waitUntil: "networkidle" });
    }

    journeyStage = "validate-unavailable-invitations";
    for (const unicodeEmail of [bmpUnicodeEmail, astralUnicodeEmail]) {
      const requestsBefore = invitationBffRequestCount;
      await adminPage.getByLabel("Invitee email").fill(unicodeEmail);
      await adminPage.getByRole("button", { name: "Issue Organization invitation" }).click();
      await waitForCondition(() => observedUnavailableEmails.includes(unicodeEmail));
      await adminPage.getByRole("alert").filter({ hasText: "unavailable, already invited, or already a member" }).waitFor();
      assert.equal(invitationBffRequestCount, requestsBefore + 1);
      assert.equal(organizationIssueCount, 0);
      await adminPage.reload({ waitUntil: "networkidle" });
    }

    await adminPage.getByLabel("Invitee email").fill("unavailable@example.test");
    await adminPage.getByRole("button", { name: "Issue Organization invitation" }).click();
    const unavailableError = adminPage.getByRole("alert").filter({ hasText: "unavailable, already invited, or already a member" });
    await unavailableError.waitFor();
    assert.equal((await unavailableError.textContent())?.includes("unavailable@example.test"), false);
    assert.equal(organizationIssueCount, 0);

    await adminPage.getByLabel("Invitee email").fill("mail-queued@example.test");
    await adminPage.getByRole("button", { name: "Issue Organization invitation" }).click();
    await adminPage.getByRole("status").filter({ hasText: "invitation email is queued" }).waitFor();
    assert.equal(await adminPage.locator("output").count(), 0);
    assert.equal(organizationIssueCount, 0);

    journeyStage = "issue-and-revoke-invitation";
    await adminPage.getByLabel("Invitee email").fill("Invitee@Example.Test");
    await adminPage.getByRole("button", { name: "Issue Organization invitation" }).click();
    let invitationUrl = await visibleOneTimeUrl(adminPage);
    await waitForCondition(() => organizationIssueCount === 1);
    assert.equal(await adminPage.getByLabel("Invitee email").inputValue(), "");
    await adminPage.reload({ waitUntil: "networkidle" });
    await adminPage.getByRole("button", { name: "Reissue" }).click();
    const reissuedUrl = await visibleOneTimeUrl(adminPage);
    assert.notEqual(reissuedUrl, invitationUrl);
    const revokedUrl = reissuedUrl;
    await waitForCondition(() => organizationReissueCount === 1);
    await adminPage.reload({ waitUntil: "networkidle" });
    await adminPage.getByText(/superseded · expires/u).waitFor();
    const pendingInvitation = adminPage.getByRole("list", { name: "Organization invitations" }).locator("li").filter({ hasText: "pending" });
    await pendingInvitation.getByRole("button", { name: "Revoke" }).click();
    await waitForCondition(() => organizationRevokeCount === 1);
    await adminPage.reload({ waitUntil: "networkidle" });
    await adminPage.getByText(/revoked · expires/u).waitFor();

    journeyStage = "validate-revoked-invitation";
    await inviteePage.goto(revokedUrl, { waitUntil: "networkidle" });
    const revokedAccept = inviteePage.getByRole("button", { name: "Accept invitation" });
    if (await revokedAccept.count() !== 1) {
      throw new Error(`revoked invitation page did not render: ${inviteePage.url()} ${await inviteePage.locator("body").innerText()}`);
    }
    await revokedAccept.click();
    const terminalError = inviteePage.getByRole("alert").filter({ hasText: "expired, used, revoked, or replaced" });
    await terminalError.waitFor();
    assert.equal((await terminalError.textContent())?.includes("nrt_org_inv_"), false);

    journeyStage = "validate-malformed-terminal-responses";
    await adminPage.getByLabel("Invitee email").fill("invitee@example.test");
    await adminPage.getByRole("button", { name: "Issue Organization invitation" }).click();
    const malformedUrl = await visibleOneTimeUrl(adminPage);
    await waitForCondition(() => organizationIssueCount === 2);

    malformedAcceptOnce = true;
    await inviteePage.goto(malformedUrl, { waitUntil: "networkidle" });
    await Promise.all([
      inviteePage.waitForResponse((response) => response.url().endsWith("/api/v1/me/organization-invitations/accept")),
      inviteePage.getByRole("button", { name: "Accept invitation" }).click()
    ]);
    await inviteePage.getByRole("alert").filter({ hasText: "The request could not be completed" }).waitFor();
    assert.equal(inviteePage.url(), malformedUrl);
    await inviteePage.goto(`${publicOrigin}/workspaces`, { waitUntil: "networkidle" });
    assert.equal(await inviteePage.getByText("Alpha Organization", { exact: true }).count(), 0);
    assert.equal(await inviteePage.getByText("Organization invitation accepted", { exact: false }).count(), 0);

    malformedDeclineOnce = true;
    await inviteePage.goto(malformedUrl, { waitUntil: "networkidle" });
    await Promise.all([
      inviteePage.waitForResponse((response) => response.url().endsWith("/api/v1/me/organization-invitations/decline")),
      inviteePage.getByRole("button", { name: "Decline" }).click()
    ]);
    await inviteePage.getByRole("alert").filter({ hasText: "The request could not be completed" }).waitFor();
    assert.equal(inviteePage.url(), malformedUrl);
    await inviteePage.goto(`${publicOrigin}/workspaces`, { waitUntil: "networkidle" });
    assert.equal(await inviteePage.getByText("Alpha Organization", { exact: true }).count(), 0);
    assert.equal(await inviteePage.getByText("Organization invitation declined", { exact: false }).count(), 0);

    await adminPage.reload({ waitUntil: "networkidle" });
    const malformedPending = adminPage.getByRole("list", { name: "Organization invitations" }).locator("li").filter({ hasText: "pending" });
    await malformedPending.getByRole("button", { name: "Revoke" }).click();
    await waitForCondition(() => organizationRevokeCount === 2);
    await adminPage.reload({ waitUntil: "networkidle" });

    journeyStage = "decline-issue";
    await adminPage.getByLabel("Invitee email").fill("invitee@example.test");
    await adminPage.getByRole("button", { name: "Issue Organization invitation" }).click();
    const declineUrl = await visibleOneTimeUrl(adminPage);
    await waitForCondition(() => organizationIssueCount === 3);
    journeyStage = "decline-open";
    await inviteePage.goto(declineUrl, { waitUntil: "networkidle" });
    journeyStage = "decline-submit";
    await inviteePage.getByRole("button", { name: "Decline" }).click();
    await inviteePage.waitForURL("**/workspaces?invitation=declined");
    assert.equal(inviteePage.url().includes("token="), false);
    journeyStage = "decline-workspace";
    await inviteePage.getByRole("status").filter({ hasText: "Organization invitation declined" }).waitFor();
    assert.equal(await inviteePage.getByText("Alpha Organization", { exact: true }).count(), 0);

    journeyStage = "accept-invitation";
    await adminPage.getByLabel("Invitee email").fill("invitee@example.test");
    await adminPage.getByRole("button", { name: "Issue Organization invitation" }).click();
    invitationUrl = await visibleOneTimeUrl(adminPage);
    await waitForCondition(() => organizationIssueCount === 4);
    await inviteePage.goto(invitationUrl, { waitUntil: "networkidle" });
    await inviteePage.getByRole("button", { name: "Accept invitation" }).click();
    await inviteePage.waitForURL("**/workspaces?joined=1");
    assert.equal(inviteePage.url().includes("token="), false);
    await inviteePage.getByRole("status").filter({ hasText: "Organization invitation accepted" }).waitFor();
    await inviteePage.getByText("Invitee Personal", { exact: true }).waitFor();
    const selector = inviteePage.getByRole("navigation", { name: "Available Workspaces" });
    const shared = selector.getByRole("link", { name: /Alpha Organization Organization Workspace/u });
    await shared.waitFor();
    await Promise.all([
      inviteePage.waitForURL("**/workspaces?workspace=0199ee6c-c777-7000-8000-000000009202"),
      shared.click()
    ]);
    assert.equal(await shared.getAttribute("aria-current"), "page");
    await inviteePage.goto(`${publicOrigin}/organizations?organization=${organizationId}`, {
      waitUntil: "networkidle"
    });
    await inviteePage.getByText("Member access is read-only. The server enforces every mutation.").waitFor();
    assert.equal(await inviteePage.getByRole("heading", { name: "Invite member" }).count(), 0);

    journeyStage = "mutate-member";
    await adminPage.goto(`${publicOrigin}/organizations?organization=${organizationId}`, { waitUntil: "networkidle" });
    const inviteeMember = adminPage.locator(".record-list li").filter({ hasText: "Invited Teammate" });
    await inviteeMember.getByRole("button", { name: "Make owner" }).click();
    try {
      await waitForCondition(() => memberRoleChangeCount === 1);
    } catch {
      throw new Error(`member role mutation did not reach Core: ${adminPage.url()} ${await adminPage.locator("body").innerText()}`);
    }
    await adminPage.reload({ waitUntil: "networkidle" });
    const updatedInviteeMember = adminPage.locator(".record-list li").filter({ hasText: "Invited Teammate" });
    const makeMember = updatedInviteeMember.getByRole("button", { name: "Make member" });
    if (await makeMember.count() !== 1) {
      throw new Error(`member role mutation was not rendered: ${adminPage.url()} ${await adminPage.locator("body").innerText()}`);
    }
    await updatedInviteeMember.getByRole("button", { name: "Remove" }).click();
    await waitForCondition(() => memberDeleteCount === 1);
    await adminPage.reload({ waitUntil: "networkidle" });
    await adminPage.getByText("Invited Teammate", { exact: true }).waitFor({ state: "detached" });
    assert.ok(observedMutationCookies.some((value) => value.endsWith(":admin")));
    assert.ok(observedMutationCookies.some((value) => value.endsWith(":invitee")));
    journeyStage = "verify-secret-safety";
    assert.equal(serverOutput.detected, false);
    journeyStage = "close-contexts";
    await admin.close();
    await invitee.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(
    `collaboration browser journey failed at ${journeyStage} (${secretSafeFailureCategory(error)}); secret-safe server output: ${serverOutput.render()}`
  );
} finally {
  await stopChild(web);
  core.close();
}

console.log("web collaboration browser journey ok");

type Session = "admin" | "invitee";
type CollaborationJourneyStage =
  | "accept-invitation"
  | "activate-invitee"
  | "authenticate-invitee"
  | "bootstrap-admin"
  | "close-contexts"
  | "create-organization"
  | "decline-issue"
  | "decline-open"
  | "decline-submit"
  | "decline-workspace"
  | "issue-and-revoke-invitation"
  | "launch-browser"
  | "mutate-member"
  | "validate-client-rejection"
  | "validate-invitation-form"
  | "validate-malformed-terminal-responses"
  | "validate-revoked-invitation"
  | "validate-unavailable-invitations"
  | "verify-secret-safety";
type InvitationStatus = "pending" | "accepted" | "declined" | "revoked" | "superseded";
interface OrganizationMember {
  userId: string;
  displayName: string;
  role: "owner" | "member";
}
interface OrganizationInvitation {
  acceptedAt: string | null;
  createdAt: string;
  declinedAt: string | null;
  expiredAt: null;
  expiresAt: string;
  id: string;
  inviteeUserId: string;
  organizationId: string;
  proposedRole: "owner" | "member";
  replacementId: string | null;
  revokedAt: string | null;
  status: InvitationStatus;
  supersededAt: string | null;
}

function activationRecord() {
  return { id: activationId, email: "invitee@example.test", status: "pending", created_at: now, expires_at: later, accepted_at: null, revoked_at: null, superseded_at: null, replacement_id: null };
}

function organization() {
  return { id: organizationId, slug: "alpha", displayName: "Alpha Organization", status: "active", createdAt: now, updatedAt: now, archivedAt: null, version: 1 };
}

function newOrganizationInvitation(role: "owner" | "member" = "member"): OrganizationInvitation {
  invitationSequence += 1;
  return { id: `0199ee6c-c777-7000-8000-${String(9400 + invitationSequence).padStart(12, "0")}`, organizationId, inviteeUserId: inviteeId, proposedRole: role, status: "pending", createdAt: now, expiresAt: later, acceptedAt: null, declinedAt: null, expiredAt: null, revokedAt: null, supersededAt: null, replacementId: null };
}

function invitationToken(invitation: OrganizationInvitation): string {
  return `nrt_org_inv_${invitation.id.slice(-1).repeat(43)}`;
}

function issuedOrganizationInvitation(invitation: OrganizationInvitation) {
  const token = invitationToken(invitation);
  addForbiddenServerValue(token);
  return { ...invitation, delivery: "copy_once", acceptUrl: `${publicOrigin}/organization-invitations/accept?token=${token}` };
}

function issueOrganizationInvitation(response: http.ServerResponse, role: "owner" | "member") {
  const invitation = newOrganizationInvitation(role);
  organizationInvitations.push(invitation);
  organizationIssueCount += 1;
  return sendJson(response, issuedOrganizationInvitation(invitation), 201);
}

function sessionFrom(cookie: string | undefined): Session | undefined {
  if (cookie?.includes("nuriteo_dev_session=admin")) return "admin";
  if (cookie?.includes("nuriteo_dev_session=invitee")) return "invitee";
  return undefined;
}

function currentUser(session: Session) {
  const admin = session === "admin";
  return { user: { id: admin ? adminId : inviteeId, email: admin ? "admin@example.test" : "invitee@example.test", display_name: admin ? "Instance Administrator" : "Invited Teammate", is_instance_admin: admin }, session: { id: admin ? "0199ee6c-c777-7000-8000-000000009002" : "0199ee6c-c777-7000-8000-000000009102", last_seen_at: now, idle_expires_at: "2026-10-04T01:00:00.000Z", absolute_expires_at: "2026-10-05T00:00:00.000Z" } };
}

function workspaces(session: Session) {
  const personal = { ownerType: "user", ownerId: session === "admin" ? adminId : inviteeId, displayLabel: session === "admin" ? "Admin Personal" : "Invitee Personal", storageScopeId: session === "admin" ? "0199ee6c-c777-7000-8000-000000009003" : "0199ee6c-c777-7000-8000-000000009103" };
  const shared = { ownerType: "organization", ownerId: organizationId, displayLabel: "Alpha Organization", storageScopeId: "0199ee6c-c777-7000-8000-000000009202" };
  if (!organizationCreated) return [personal];
  if (session === "admin" || members.some((member) => member.userId === inviteeId)) return [personal, shared];
  return [personal];
}

function visibleMemberPage(): OrganizationMember[] {
  const fillers: OrganizationMember[] = Array.from({ length: 100 }, (_, index) => ({
    userId: `0199ee6c-c777-7000-8000-${String(100_000 + index).padStart(12, "0")}`,
    displayName: `Member ${index + 1}`,
    role: "member"
  }));
  const invitee = members.find((member) => member.userId === inviteeId);
  return invitee === undefined ? fillers : [invitee, ...fillers.slice(0, 99)];
}

async function visibleOneTimeUrl(page: import("@playwright/test").Page): Promise<string> {
  const output = page.locator("output");
  await output.waitFor();
  const value = await output.textContent();
  if (value === null || !value.includes("/organization-invitations/accept?token=nrt_org_inv_")) {
    throw new Error("one-time invitation URL was not displayed");
  }
  return value;
}

function sendJson(response: http.ServerResponse, value: unknown, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function sendProblem(response: http.ServerResponse, status: number, code: string) {
  response.statusCode = status;
  response.setHeader("content-type", "application/problem+json");
  response.end(JSON.stringify({ type: "about:blank", title: "Request rejected", status, detail: "The request could not be completed.", instance: "/api/v1", code, request_id: "collaboration-browser-request", errors: [] }));
}

async function jsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
}

async function reservePort(): Promise<number> {
  const reservation = http.createServer();
  await listen(reservation);
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function startStandaloneWeb(corePort: number) {
  const maximumAttempts = 5;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [serverEntry], {
      cwd: standaloneWeb,
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${corePort}`,
        PORT: String(port)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
      stream.on("data", (chunk: Buffer) => {
        serverOutput.record(name satisfies OutputStreamName, chunk);
      });
    }
    try {
      await waitUntilReady(origin, child);
      return { child, origin };
    } catch {
      await stopChild(child);
      if (attempt === maximumAttempts) {
        throw new Error("standalone server did not become ready after bounded bind retries");
      }
    }
  }
  throw new Error("standalone server bind retry invariant failed");
}

async function waitUntilReady(origin: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("standalone server exited before readiness");
    }
    try {
      const response = await fetch(`${origin}/sign-in`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch { /* standalone is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("standalone server did not become ready");
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  if (await Promise.race([exited, new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("browser fixture condition was not observed");
}
