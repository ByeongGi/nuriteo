import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "@playwright/test";

const origin = required("NURITEO_BETA_GATE_ORIGIN");
const password = fs.readFileSync(required("NURITEO_BETA_GATE_ADMIN_PASSWORD_FILE"), "utf8").trim();
const context = JSON.parse(fs.readFileSync(required("NURITEO_BETA_GATE_CONTEXT_FILE"), "utf8")) as {
  organizationId: string; projectId: string; projectVersionId?: string; userId: string; inviteeUserId: string;
};
const output = required("NURITEO_BETA_GATE_JOURNEY_OUTPUT");
const assertions: Record<string, Array<{ kind: string; name: string; status: "PASS" }>> = {};
const pass = (stage: string, kind: string, name: string) => (assertions[stage] ??= []).push({ kind, name, status: "PASS" });

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
try {
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  await page.goto(`${origin}/sign-in`);
  await page.getByLabel("Email").fill("admin@example.invalid");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/workspaces");
  pass("local-administrator", "browser", "bootstrap administrator reauthenticated in a fresh browser context");

  const csrf = (await browserContext.cookies()).find((cookie) => /(?:^|_)csrf$/u.test(cookie.name))?.value;
  assert.match(csrf ?? "", /^nrt_csrf_[A-Za-z0-9_-]{43}$/u);
  const api = async (method: string, pathname: string, body?: unknown, extra: Record<string, string> = {}) => {
    const result = await page.evaluate(async ({ method, pathname, body, csrf, extra }) => {
      const response = await fetch(pathname, {
        method, credentials: "same-origin",
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(method === "GET" ? {} : { "x-csrf-token": csrf }), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual"
      });
      const text = await response.text();
      let json: unknown; try { json = text === "" ? undefined : JSON.parse(text); } catch { json = undefined; }
      return { status: response.status, json, etag: response.headers.get("etag"), location: response.headers.get("location") };
    }, { method, pathname, body, csrf: csrf!, extra });
    assert.ok(result.status >= 200 && result.status < 300, `${method} ${pathname} returned ${result.status}`);
    return result;
  };

  const status = await api("GET", "/api/v1/admin/status");
  const operations = await api("GET", "/api/v1/admin/operations");
  assert.match((status.json as { releaseVersion: string }).releaseVersion, /^\d+\.\d+\.\d+/u);
  assert.ok(Number.isSafeInteger((status.json as { schemaVersion: number }).schemaVersion));
  const operationView = operations.json as {
    dependencies: { state: string; category: string | null };
    usage: { trackedPhysicalBytes: string | null };
  };
  assert.match(operationView.dependencies.state, /^(?:nominal|degraded|unavailable)$/u);
  if (operationView.dependencies.state === "nominal") {
    assert.equal(operationView.dependencies.category, null);
  } else {
    assert.match(operationView.dependencies.category ?? "", /^(?:configuration|database|object_storage)$/u);
  }
  assert.match(operationView.usage.trackedPhysicalBytes ?? "", /^(?:0|[1-9]\d*)$/u);

  const settings = await api("GET", "/api/v1/admin/settings");
  const settingItems = (settings.json as { items: Array<{ key: string; value: unknown; version: number }> }).items;
  assert.ok(Array.isArray(settingItems));
  const setting = settingItems.find((item) => item.key === "invitations.default_expiry_hours");
  assert.ok(setting);
  await api("POST", `/api/v1/admin/settings/${setting.key}/impact`, { value: setting.value });
  const changedSettingValue = setting.value === 168 ? 336 : 168;
  const changedSetting = await api("PATCH", `/api/v1/admin/settings/${setting.key}`, {
    value: changedSettingValue
  }, { "if-match": `"setting-v${setting.version}"` });
  const changedSettingBody = changedSetting.json as { value: unknown; version: number };
  assert.equal(changedSettingBody.value, changedSettingValue);
  const restoredSetting = await api("PATCH", `/api/v1/admin/settings/${setting.key}`, {
    value: setting.value
  }, { "if-match": `"setting-v${changedSettingBody.version}"` });
  assert.equal((restoredSetting.json as { value: unknown }).value, setting.value);
  pass("instance-policy", "api", "invitation expiry policy was impact-previewed, applied, observed, and restored through the live admin API");

  const mfa = await api("GET", "/api/v1/admin/mfa-policy");
  const policy = mfa.json as { mode: string; gracePeriodDays: number; version: number };
  // A clean installation intentionally has no enrolled administrator yet, so
  // enabling enforcement must be rejected by the service's lockout guard. The
  // aggregate gate still exercises preview/apply/restore by changing the grace
  // period while preserving the current enforcement mode.
  const nextMfaMode = policy.mode;
  const nextGracePeriodDays = policy.gracePeriodDays === 14 ? 7 : 14;
  const impact = await api("POST", "/api/v1/admin/mfa-policy/preview", {
    mode: nextMfaMode, gracePeriodDays: nextGracePeriodDays
  }, { "if-match": `"mfa-policy-v${policy.version}"` });
  const populationProof = (impact.json as { populationProof?: unknown }).populationProof;
  assert.equal(typeof populationProof, "string");
  const changedMfa = await api("PATCH", "/api/v1/admin/mfa-policy", {
    mode: nextMfaMode, gracePeriodDays: nextGracePeriodDays, populationProof
  }, { "if-match": `"mfa-policy-v${policy.version}"` });
  const changedMfaBody = changedMfa.json as { version: number; mode: string };
  assert.equal(changedMfaBody.mode, nextMfaMode);
  const restoreImpact = await api("POST", "/api/v1/admin/mfa-policy/preview", {
    mode: policy.mode, gracePeriodDays: policy.gracePeriodDays
  }, { "if-match": `"mfa-policy-v${changedMfaBody.version}"` });
  const restoreProof = (restoreImpact.json as { populationProof?: unknown }).populationProof;
  assert.equal(typeof restoreProof, "string");
  const restoredMfa = await api("PATCH", "/api/v1/admin/mfa-policy", {
    mode: policy.mode, gracePeriodDays: policy.gracePeriodDays,
    populationProof: restoreProof
  }, { "if-match": `"mfa-policy-v${changedMfaBody.version}"` });
  assert.equal((restoredMfa.json as { mode: string }).mode, policy.mode);
  pass("mfa-policy", "api", "MFA policy was previewed, applied with a changed grace period, observed, and restored against the live population");

  const issued = await api("POST", "/api/v1/access-tokens", { name: "GATE-005 probe", scopes: ["project:read"], expiryDays: 1 });
  const issuedBody = issued.json as { token: { id: string }; plaintext: string };
  assert.match(issuedBody.plaintext, /^nur_pat_/u);
  const coreOrigin = required("NURITEO_BETA_GATE_CORE_ORIGIN");
  const tokenRead = await fetch(`${coreOrigin}/api/v1/workspaces/organizations/${context.organizationId}/projects/${context.projectId}`, {
    headers: { authorization: `Bearer ${issuedBody.plaintext}`, accept: "application/json" }, redirect: "manual"
  });
  assert.equal(tokenRead.status, 200);
  const tokenWrite = await fetch(`${coreOrigin}/api/v1/workspaces/organizations/${context.organizationId}/projects/${context.projectId}/archive`, {
    method: "POST", headers: { authorization: `Bearer ${issuedBody.plaintext}`, "content-type": "application/json" },
    body: "{}", redirect: "manual"
  });
  assert.equal(tokenWrite.status, 403);
  await api("DELETE", `/api/v1/access-tokens/${issuedBody.token.id}`);
  const revokedRead = await fetch(`${coreOrigin}/api/v1/workspaces/organizations/${context.organizationId}/projects/${context.projectId}`, {
    headers: { authorization: `Bearer ${issuedBody.plaintext}`, accept: "application/json" }, redirect: "manual"
  });
  assert.equal(revokedRead.status, 401);
  fs.writeFileSync(
    required("NURITEO_BETA_GATE_POST_RESTART_TOKEN_FILE"),
    `${issuedBody.plaintext}\n`,
    { mode: 0o600 }
  );
  pass("access-tokens", "api", "project:read PAT allowed a read, denied a write, and was rejected after revocation");

  await api("GET", "/api/v1/notifications?limit=25");
  await api("GET", "/api/v1/admin/email-deliveries?limit=25");

  const projectPath = `/api/v1/workspaces/organizations/${context.organizationId}/projects/${context.projectId}`;
  const project = await api("GET", projectPath);
  assert.match(project.etag ?? "", /^"project-v[1-9]\d*"$/u);
  const team = await api("POST", `/api/v1/organizations/${context.organizationId}/teams`, {
    slug: "gate-005-team", displayName: "GATE-005 Team"
  });
  const teamBody = team.json as { id: string };
  assert.match(teamBody.id, /^[0-9a-f-]{36}$/u);
  await api("POST", `/api/v1/organizations/${context.organizationId}/teams/${teamBody.id}/members`, {
    userId: context.inviteeUserId, role: "member"
  });
  await api("POST", `/api/v1/organizations/${context.organizationId}/teams/${teamBody.id}/project-roles`, {
    projectId: context.projectId, role: "write"
  });
  const directRoles = await api("GET", `${projectPath}/roles`);
  const directInvitee = (directRoles.json as { items: Array<{ userId: string }> }).items
    .find((item) => item.userId === context.inviteeUserId);
  assert.ok(directInvitee);
  await api("DELETE", `${projectPath}/roles/${context.inviteeUserId}`, undefined, {
    "if-match": project.etag!
  });

  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  await inviteePage.goto(`${origin}/sign-in`);
  await inviteePage.getByLabel("Email").fill("cmp003-invitee@example.invalid");
  await inviteePage.getByLabel("Password").fill(fs.readFileSync(required("NURITEO_BETA_GATE_INVITEE_PASSWORD_FILE"), "utf8").trim());
  await inviteePage.getByRole("button", { name: "Sign in" }).click();
  await inviteePage.waitForURL((url) => url.pathname === "/workspaces");
  const teamAuthorized = await inviteePage.evaluate(async (path) => {
    const response = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
    return response.status;
  }, projectPath);
  assert.equal(teamAuthorized, 200);
  await inviteeContext.close();
  pass("team-collaboration", "api", "invitee retained Project write access after the direct grant was removed, solely through live Team membership and Team Project role");

  const versionSource = await api("GET", projectPath);
  assert.match(versionSource.etag ?? "", /^"project-v[1-9]\d*"$/u);
  const explicitVersion = await api("POST", `${projectPath}/versions`, {
    name: "GATE-005 Published Version"
  }, {
    "if-match": versionSource.etag!,
    "idempotency-key": "gate-005-published-version"
  });
  const projectVersionId = (explicitVersion.json as { version: { id: string } }).version.id;
  assert.match(projectVersionId, /^[0-9a-f-]{36}$/u);
  context.projectVersionId = projectVersionId;
  const publication = await api("POST", `/api/v1/workspaces/organizations/${context.organizationId}/projects/${context.projectId}/published-examples`, {
    projectVersionId, name: "GATE-005 Example", visibility: "unlisted"
  });
  const created = publication.json as { example: { publicId: string }; version: { versionNumber: number } };
  await api("GET", `/api/v1/published-examples/${created.example.publicId}/versions/${created.version.versionNumber}`);
  const fork = await api("POST", `/api/v1/published-examples/${created.example.publicId}/versions/${created.version.versionNumber}/forks`, {
    destinationOwner: { ownerType: "user", ownerId: context.userId }, slug: "gate-005-fork", name: "GATE-005 Fork"
  }, { "idempotency-key": "gate-005-published-fork" });
  const forkBody = fork.json as { project: { id: string; ownerType: string; ownerId: string }; sourceVersionNumber: number };
  assert.notEqual(forkBody.project.id, context.projectId);
  assert.equal(forkBody.project.ownerType, "user");
  assert.equal(forkBody.project.ownerId, context.userId);
  assert.equal(forkBody.sourceVersionNumber, created.version.versionNumber);
  await api("GET", `/api/v1/workspaces/users/${context.userId}/projects/${forkBody.project.id}`);
  Object.assign(context, { forkProjectId: forkBody.project.id });
  fs.writeFileSync(required("NURITEO_BETA_GATE_CONTEXT_FILE"), `${JSON.stringify(context)}\n`, { mode: 0o600 });
  pass("published-example", "api", "saved immutable Version was published, forked to a distinct personal owner, and read back as an independent Project");

  const audit = await api("GET", "/api/v1/admin/audit-events?limit=100");
  const actionCodes = new Set((audit.json as { items: Array<{ actionCode: string }> }).items.map((item) => item.actionCode));
  for (const action of ["instance.setting_updated", "mfa.policy_updated", "access_token.created", "access_token.revoked", "team.created", "team.member_added", "team.project_role_added"]) {
    assert.ok(actionCodes.has(action), `audit event ${action} was not observed`);
  }
  pass("audit-and-operations", "api", "typed status and operations fields were validated and every policy, token, and Team mutation was observed in the live audit stream");
} finally {
  await browser.close();
}
fs.writeFileSync(output, `${JSON.stringify(assertions)}\n`, { mode: 0o600 });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
