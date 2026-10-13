import assert from "node:assert/strict";
import fs from "node:fs";

import { chromium, type BrowserContext, type Page } from "@playwright/test";

type ApiResult = {
  cacheControl: string | null;
  etag: string | null;
  json?: unknown;
  status: number;
};

const origin = required("NURITEO_BETA_GATE_ORIGIN");
const coreOrigin = required("NURITEO_BETA_GATE_CORE_ORIGIN");
const password = fs.readFileSync(required("NURITEO_BETA_GATE_ADMIN_PASSWORD_FILE"), "utf8").trim();
const context = JSON.parse(fs.readFileSync(required("NURITEO_BETA_GATE_CONTEXT_FILE"), "utf8")) as {
  organizationId: string;
  projectId: string;
};
const gitRegistry = JSON.parse(fs.readFileSync(required("NURITEO_GATE_GIT_REGISTRY_STATE"), "utf8")) as {
  gitProviderId: string;
  exactRegistryId: string;
  defaultRegistryId: string;
};
const oidc = JSON.parse(fs.readFileSync(required("NURITEO_GATE_OIDC_STATE_FILE"), "utf8")) as {
  id: string;
};
const tokenFile = required("NURITEO_BETA_GATE_POST_RESTART_TOKEN_FILE");
const revokedPat = fs.readFileSync(tokenFile, "utf8").trim();
const oidcPort = required("NURITEO_BETA_GATE_OIDC_PORT");

const browser = await chromium.launch({
  headless: true,
  args: ["--no-proxy-server", `--host-resolver-rules=MAP oidc-provider:8443 127.0.0.1:${oidcPort}`],
});

try {
  const admin = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await admin.newPage();
  await signIn(page, "admin@example.invalid", password);
  const csrf = (await admin.cookies()).find((cookie) => /(?:^|_)csrf$/u.test(cookie.name))?.value;
  assert.match(csrf ?? "", /^nrt_csrf_[A-Za-z0-9_-]{43}$/u);

  const api = async (
    method: string,
    pathname: string,
    body?: unknown,
    headers: Record<string, string> = {},
    expected = [200],
  ): Promise<ApiResult> => {
    const result = await page.evaluate(async ({ method, pathname, body, headers, csrf }) => {
      const response = await fetch(pathname, {
        method,
        credentials: "same-origin",
        redirect: "manual",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(method === "GET" ? {} : { "x-csrf-token": csrf }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json: unknown;
      try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
      return {
        cacheControl: response.headers.get("cache-control"),
        etag: response.headers.get("etag"),
        json,
        status: response.status,
      };
    }, { method, pathname, body, headers, csrf: csrf! }) as ApiResult;
    assert.ok(expected.includes(result.status), `${method} ${pathname}: expected ${expected}, received ${result.status}`);
    assert.equal(result.cacheControl, "no-store", `${method} ${pathname} did not retain the BFF no-store boundary`);
    return result;
  };

  const revoked = await fetch(
    `${coreOrigin}/api/v1/workspaces/organizations/${context.organizationId}/projects/${context.projectId}`,
    { headers: { accept: "application/json", authorization: `Bearer ${revokedPat}` }, redirect: "manual" },
  );
  assert.equal(revoked.status, 401);
  assert.equal(revoked.headers.get("cache-control"), "private, no-store");
  fs.rmSync(tokenFile);

  const gitProviders = await api("GET", "/api/v1/admin/git-providers");
  assertRedacted(gitProviders.json);
  const persistedGit = (gitProviders.json as Array<{ id: string; state: string; validatedAt: string | null }>)
    .find((item) => item.id === gitRegistry.gitProviderId);
  assert.ok(persistedGit);
  assert.equal(persistedGit.state, "active");
  assert.ok(persistedGit.validatedAt);
  await activeCa(api, "git_provider", gitRegistry.gitProviderId);

  const remote = await api("GET", `/api/v1/projects/${context.projectId}/git`);
  assert.match(remote.etag ?? "", /^"git-remote-[0-9a-f]{40,64}"$/u);
  const pulled = await api("POST", `/api/v1/projects/${context.projectId}/git/pull`, undefined, {
    "if-match": remote.etag!,
  });
  assert.match(pulled.etag ?? "", /^"git-remote-[0-9a-f]{40,64}"$/u);

  const registries = await api("GET", "/api/v1/admin/registries");
  assertRedacted(registries.json);
  const registryBody = registries.json as {
    items: Array<{ configVersion: number; id: string; isDefault: boolean; state: string; validatedAt: string | null }>;
    scopes: Array<{ connectionId: string; scope: string }>;
  };
  const exact = registryBody.items.find((item) => item.id === gitRegistry.exactRegistryId);
  const fallback = registryBody.items.find((item) => item.id === gitRegistry.defaultRegistryId);
  assert.ok(exact && fallback);
  assert.equal(exact.state, "disabled");
  assert.equal(fallback.state, "active");
  assert.equal(fallback.isDefault, true);
  assert.ok(fallback.validatedAt);
  assert.ok(registryBody.scopes.some((item) => item.scope === "@gate" && item.connectionId === exact.id));
  await activeCa(api, "registry", exact.id);
  await activeCa(api, "registry", fallback.id);
  const reactivated = await api("POST", `/api/v1/admin/registries/${exact.id}/activate`, undefined, {
    "if-match": `"registry-v${exact.configVersion}"`,
  });
  assert.equal((reactivated.json as { state: string }).state, "active");

  const providers = await api("GET", "/api/v1/admin/oidc/providers");
  assertRedacted(providers.json);
  const persistedOidc = (providers.json as { items: Array<{ id: string; linkedIdentityCount: number; state: string }> }).items
    .find((item) => item.id === oidc.id);
  assert.ok(persistedOidc);
  assert.equal(persistedOidc.state, "active");
  assert.ok(persistedOidc.linkedIdentityCount >= 1);
  await activeCa(api, "oidc", oidc.id);

  const sentDeliveries = await api("GET", "/api/v1/admin/email-deliveries?state=sent&limit=100");
  const deadLetterDeliveries = await api("GET", "/api/v1/admin/email-deliveries?state=dead_letter&limit=100");
  assertRedacted(sentDeliveries.json);
  assertRedacted(deadLetterDeliveries.json);
  const sentBody = sentDeliveries.json as {
    items: Array<{ attemptCount: number; state: string }>;
    smtpConfigured: boolean;
  };
  const deadLetterBody = deadLetterDeliveries.json as {
    items: Array<{ attemptCount: number; state: string }>;
    smtpConfigured: boolean;
  };
  assert.equal(sentBody.smtpConfigured, true);
  assert.equal(deadLetterBody.smtpConfigured, true);
  assert.ok(sentBody.items.some((item) => item.state === "sent" && item.attemptCount >= 2));
  assert.ok(deadLetterBody.items.some((item) => item.state === "dead_letter"));
  await admin.close();

  const oidcLogin = await browser.newContext({ ignoreHTTPSErrors: true });
  const oidcPage = await oidcLogin.newPage();
  await oidcPage.goto(`${origin}/sign-in`, { waitUntil: "networkidle" });
  await oidcPage.getByRole("link", { name: "Continue with GATE-005 invited user SSO" }).click();
  await oidcPage.waitForURL((url) => url.origin === origin && url.pathname === "/workspaces");
  const identities = await oidcPage.evaluate(async () => {
    const response = await fetch("/api/v1/me/oidc-identities", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    return { cacheControl: response.headers.get("cache-control"), json: await response.json(), status: response.status };
  });
  assert.equal(identities.status, 200);
  assert.equal(identities.cacheControl, "no-store");
  assert.ok((identities.json as { items: Array<{ providerId: string }> }).items.some((item) => item.providerId === oidc.id));
  await oidcLogin.close();

  fs.writeFileSync(required("NURITEO_BETA_GATE_POST_RESTART_OUTPUT"), `${JSON.stringify([
    { kind: "api", name: "revoked PAT remained rejected after the same-volume restart", status: "PASS" },
    { kind: "api", name: "Git provider, credential, remote and active CA persisted and completed a post-restart pull", status: "PASS" },
    { kind: "api", name: "Registry default, exact scope, credentials and active CAs persisted and the exact Registry reactivated", status: "PASS" },
    { kind: "browser", name: "active OIDC provider and CA persisted and completed a fresh post-restart login", status: "PASS" },
    { kind: "database", name: "SMTP configuration and terminal sent, retry and dead-letter outcomes persisted", status: "PASS" },
    { kind: "api", name: "post-restart administrative responses retained no-store caching and credential redaction", status: "PASS" },
  ])}\n`, { mode: 0o600 });
} finally {
  await browser.close();
}

async function activeCa(
  api: (method: string, pathname: string, body?: unknown, headers?: Record<string, string>, expected?: number[]) => Promise<ApiResult>,
  type: "git_provider" | "oidc" | "registry",
  id: string,
): Promise<void> {
  const response = await api("GET", `/api/v1/admin/integrations/${type}/${id}/ca`);
  assert.match(response.etag ?? "", /^"integration-ca-v[1-9]\d*"$/u);
  assertRedacted(response.json);
  const items = (response.json as { items: Array<{ fingerprints: string[]; state: string }> }).items;
  const active = items.find((item) => item.state === "active");
  assert.ok(active);
  assert.ok(active.fingerprints.length > 0);
  assert.ok(active.fingerprints.every((value) => /^[0-9a-f]{64}$/u.test(value)));
}

function assertRedacted(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.ok(!/BEGIN (?:CERTIFICATE|(?:RSA |EC )?PRIVATE KEY)|"(?:clientSecret|password|plaintext|privateKey|secret|token)"\s*:/iu.test(serialized),
    `response exposed protected material: ${serialized}`);
}

async function signIn(page: Page, email: string, secret: string): Promise<void> {
  await page.goto(`${origin}/sign-in`, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(secret);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/workspaces");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
