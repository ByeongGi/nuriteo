import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "@playwright/test";

const origin = required("NURITEO_BETA_GATE_ORIGIN");
const phase = required("NURITEO_GATE_OIDC_PHASE");
const stateFile = required("NURITEO_GATE_OIDC_STATE_FILE");
const oidcPort = required("NURITEO_BETA_GATE_OIDC_PORT");
const password = fs.readFileSync(required("NURITEO_BETA_GATE_ADMIN_PASSWORD_FILE"), "utf8").trim();

const browser = await chromium.launch({
  headless: true,
  args: ["--no-proxy-server", `--host-resolver-rules=MAP oidc-provider:8443 127.0.0.1:${oidcPort}`],
});
try {
  if (phase === "create") {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await signIn(page, "admin@example.invalid", password);
    const created = await api(context, page, "POST", "/api/v1/admin/oidc/providers", {
      displayName: "GATE-005 invited user SSO",
      issuer: "https://oidc-provider:8443",
      clientId: "gate-005",
      clientSecret: "gate-005-client-secret",
    });
    const provider = created.json as { id: string; configVersion: number; state: string };
    assert.match(provider.id, /^[0-9a-f-]{36}$/u);
    assert.equal(provider.state, "disabled");
    const trustPath = `/api/v1/admin/integrations/oidc/${provider.id}/ca`;
    const trust = await api(context, page, "GET", trustPath);
    const trustVersion = (trust.json as { version: number }).version;
    const pem = fs.readFileSync(`${required("NURITEO_BETA_GATE_PROVIDER_TLS_DIR")}/ca.crt`, "utf8");
    const staged = await api(context, page, "POST", `${trustPath}/candidates`, { pem }, {
      "if-match": `"integration-ca-v${trustVersion}"`,
      "idempotency-key": `gate-005-oidc-ca-stage-${provider.id}`,
    });
    const candidate = staged.json as { id: string; version: number; state: string };
    assert.equal(candidate.state, "candidate");
    const activatedCa = await api(context, page, "POST", `${trustPath}/candidates/${candidate.id}/activate`, undefined, {
      "if-match": `"integration-ca-v${candidate.version}"`,
      "idempotency-key": `gate-005-oidc-ca-activate-${provider.id}`,
    });
    assert.equal((activatedCa.json as { state: string }).state, "active");
    fs.writeFileSync(stateFile, `${JSON.stringify(provider)}\n`, { mode: 0o600 });
    await context.close();
  } else if (phase === "activate-login") {
    const provider = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { id: string; configVersion: number };
    const admin = await browser.newContext({ ignoreHTTPSErrors: true });
    const adminPage = await admin.newPage();
    await signIn(adminPage, "admin@example.invalid", password);
    const activated = await api(
      admin,
      adminPage,
      "POST",
      `/api/v1/admin/oidc/providers/${provider.id}/activate`,
      { redirectUri: `https://oidc-provider:8443/callback-proxy/${provider.id}` },
      { "if-match": `"oidc-provider-v${provider.configVersion}"` },
    );
    assert.equal((activated.json as { state: string }).state, "active");
    await admin.close();

    fs.writeFileSync(`${required("NURITEO_BETA_GATE_PROVIDER_TLS_DIR")}/control/active-kid`, "gate-next", { mode: 0o600 });
    const invitee = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await invitee.newPage();
    await page.goto(`${origin}/sign-in`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Continue with GATE-005 invited user SSO" }).click();
    await page.waitForURL((url) => url.origin === origin && url.pathname === "/workspaces");
    const identities = await api(invitee, page, "GET", "/api/v1/me/oidc-identities");
    const items = (identities.json as { items: Array<{ providerId: string }> }).items;
    assert.ok(items.some((item) => item.providerId === provider.id));
    fs.writeFileSync(required("NURITEO_GATE_OIDC_RESULT_FILE"), `${JSON.stringify({ providerId: provider.id, login: true, identityLinked: true, jwksRotatedTo: "gate-next" })}\n`, { mode: 0o600 });
    await invitee.close();
  } else {
    throw new Error(`unknown phase ${phase}`);
  }
} finally {
  await browser.close();
}

async function signIn(page: Page, email: string, secret: string) {
  await page.goto(`${origin}/sign-in`, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(secret);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/workspaces");
}

async function api(context: BrowserContext, page: Page, method: string, pathname: string, body?: unknown, extra: Record<string, string> = {}) {
  const csrf = (await context.cookies()).find((cookie) => /(?:^|_)csrf$/u.test(cookie.name))?.value;
  const result = await page.evaluate(async ({ method, pathname, body, csrf, extra }) => {
    const response = await fetch(pathname, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { "x-csrf-token": csrf ?? "" }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  }, { method, pathname, body, csrf, extra });
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${pathname}: ${result.status} ${JSON.stringify(result.json)}`);
  return result;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
