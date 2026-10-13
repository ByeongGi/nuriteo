import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import { chromium } from "@playwright/test";

type ApiResult = { status: number; json?: unknown; etag: string | null; cacheControl: string | null };
type StageState = {
  projectId: string;
  gitProviderId?: string;
  gitConnectionId?: string;
  exactRegistryId?: string;
  exactRegistryVersion?: number;
  defaultRegistryId?: string;
  defaultRegistryVersion?: number;
};

const phase = required("NURITEO_GATE_GIT_REGISTRY_PHASE");
const origin = required("NURITEO_BETA_GATE_ORIGIN");
const statePath = required("NURITEO_GATE_GIT_REGISTRY_STATE");
const password = fs.readFileSync(required("NURITEO_BETA_GATE_ADMIN_PASSWORD_FILE"), "utf8").trim();
const providerCa = fs.readFileSync(required("NURITEO_GATE_PROVIDER_CA_FILE"), "utf8");
const input = JSON.parse(fs.readFileSync(required("NURITEO_BETA_GATE_CONTEXT_FILE"), "utf8")) as StageState;
const state: StageState = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8")) as StageState
  : { projectId: input.projectId };
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/sign-in`);
  await page.getByLabel("Email").fill("admin@example.invalid");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/workspaces");
  const csrf = (await context.cookies()).find((cookie) => /(?:^|_)csrf$/u.test(cookie.name))?.value;
  assert.match(csrf ?? "", /^nrt_csrf_[A-Za-z0-9_-]{43}$/u);

  const api = async (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}, expected = [200]) => {
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
        status: response.status,
        json,
        etag: response.headers.get("etag"),
        cacheControl: response.headers.get("cache-control"),
      };
    }, { method, pathname, body, headers, csrf: csrf! }) as ApiResult;
    assert.ok(expected.includes(result.status), `${method} ${pathname}: expected ${expected}, received ${result.status}`);
    return result;
  };

  if (phase === "configure") {
    const gitPort = Number(required("NURITEO_GATE_GIT_PORT"));
    assert.ok(Number.isInteger(gitPort) && gitPort > 0 && gitPort <= 65_535);
    const provider = await api("POST", "/api/v1/admin/git-providers", {
      displayName: "GATE-005 smart HTTPS",
      kind: "generic",
      host: required("NURITEO_GATE_GIT_HOST"),
      port: gitPort,
      apiBaseUrl: `https://${required("NURITEO_GATE_GIT_HOST")}:${gitPort}/capabilities`,
      oauthAuthorizationUrl: null,
      oauthTokenUrl: null,
      oauthClientId: null,
      allowsRead: true,
      allowsWrite: true,
    }, {}, [201]);
    const providerBody = provider.json as { id: string; configVersion: number };
    assert.equal(provider.etag, `"git-provider-v${providerBody.configVersion}"`);
    await caLifecycle("git_provider", providerBody.id);
    const activeProvider = await api("POST", `/api/v1/admin/git-providers/${providerBody.id}/activate`, undefined,
      { "if-match": `"git-provider-v${providerBody.configVersion}"` });
    assert.equal((activeProvider.json as { state: string }).state, "active");
    state.gitProviderId = providerBody.id;

    const temporaryGit = await api("POST", "/api/v1/admin/git-providers", {
      displayName: "GATE-005 lifecycle probe",
      kind: "generic",
      host: "git-lifecycle.invalid",
      port: 8443,
      apiBaseUrl: "https://git-lifecycle.invalid:8443/capabilities",
      oauthAuthorizationUrl: null,
      oauthTokenUrl: null,
      oauthClientId: null,
      allowsRead: true,
      allowsWrite: true,
    }, {}, [201]);
    assert.equal(temporaryGit.cacheControl, "no-store");
    assertRedacted(temporaryGit.json);
    const temporaryGitBody = temporaryGit.json as { id: string; configVersion: number };
    const updatedGit = await api("PATCH", `/api/v1/admin/git-providers/${temporaryGitBody.id}`, {
      displayName: "GATE-005 lifecycle probe renamed",
      apiBaseUrl: "https://git-lifecycle.invalid:8443/capabilities-v2",
      oauthAuthorizationUrl: null,
      oauthTokenUrl: null,
      oauthClientId: null,
      allowsRead: true,
      allowsWrite: false,
    }, { "if-match": `"git-provider-v${temporaryGitBody.configVersion}"` });
    assert.equal(updatedGit.cacheControl, "no-store");
    assert.equal((updatedGit.json as { displayName: string; allowsWrite: boolean }).displayName, "GATE-005 lifecycle probe renamed");
    assert.equal((updatedGit.json as { allowsWrite: boolean }).allowsWrite, false);
    assertRedacted(updatedGit.json);
    const updatedGitVersion = (updatedGit.json as { configVersion: number }).configVersion;
    const deletedGit = await api("DELETE", `/api/v1/admin/git-providers/${temporaryGitBody.id}`, undefined,
      { "if-match": `"git-provider-v${updatedGitVersion}"` }, [204]);
    assert.equal(deletedGit.cacheControl, "no-store");

    const exact = await api("POST", "/api/v1/admin/registries", {
      displayName: "GATE-005 exact scope",
      baseUrl: required("NURITEO_GATE_REGISTRY_EXACT_URL"),
      token: required("NURITEO_GATE_REGISTRY_EXACT_TOKEN"),
    });
    const defaultRegistry = await api("POST", "/api/v1/admin/registries", {
      displayName: "GATE-005 fallback sentinel",
      baseUrl: required("NURITEO_GATE_REGISTRY_DEFAULT_URL"),
      token: required("NURITEO_GATE_REGISTRY_DEFAULT_TOKEN"),
    });
    assert.equal(exact.cacheControl, "no-store");
    assert.equal(defaultRegistry.cacheControl, "no-store");
    assertRedacted(exact.json);
    assertRedacted(defaultRegistry.json);
    const exactBody = exact.json as { id: string; configVersion: number };
    const defaultBody = defaultRegistry.json as { id: string; configVersion: number };
    Object.assign(state, {
      exactRegistryId: exactBody.id,
      exactRegistryVersion: exactBody.configVersion,
      defaultRegistryId: defaultBody.id,
      defaultRegistryVersion: defaultBody.configVersion,
    });
    await caLifecycle("registry", exactBody.id);
    await caLifecycle("registry", defaultBody.id);

    const lifecycleToken = "registry-lifecycle-secret-not-returned";
    const temporaryRegistry = await api("POST", "/api/v1/admin/registries", {
      displayName: "GATE-005 Registry lifecycle probe",
      baseUrl: "https://registry-lifecycle.invalid:8443",
      token: lifecycleToken,
    });
    assert.equal(temporaryRegistry.cacheControl, "no-store");
    assert.ok(!JSON.stringify(temporaryRegistry.json).includes(lifecycleToken));
    assertRedacted(temporaryRegistry.json);
    const temporaryRegistryBody = temporaryRegistry.json as { id: string; configVersion: number };
    const renamedRegistry = await api("PATCH", `/api/v1/admin/registries/${temporaryRegistryBody.id}`, {
      displayName: "GATE-005 Registry lifecycle probe renamed",
    }, { "if-match": `"registry-v${temporaryRegistryBody.configVersion}"` });
    assert.equal((renamedRegistry.json as { displayName: string }).displayName, "GATE-005 Registry lifecycle probe renamed");
    const renamedRegistryVersion = (renamedRegistry.json as { configVersion: number }).configVersion;
    const rotatedRegistry = await api("POST", `/api/v1/admin/registries/${temporaryRegistryBody.id}/rotate-token`, {
      token: `${lifecycleToken}-rotated`,
    }, { "if-match": `"registry-v${renamedRegistryVersion}"` });
    assert.ok(!JSON.stringify(rotatedRegistry.json).includes(lifecycleToken));
    assertRedacted(rotatedRegistry.json);
    const rotatedRegistryVersion = (rotatedRegistry.json as { configVersion: number }).configVersion;
    const deletedRegistry = await api("DELETE", `/api/v1/admin/registries/${temporaryRegistryBody.id}`, undefined,
      { "if-match": `"registry-v${rotatedRegistryVersion}"` }, [204]);
    assert.equal(deletedRegistry.cacheControl, "no-store");

    const gitCollection = await api("GET", "/api/v1/admin/git-providers");
    const registryCollection = await api("GET", "/api/v1/admin/registries");
    assert.equal(gitCollection.cacheControl, "no-store");
    assert.equal(registryCollection.cacheControl, "no-store");
    assert.ok(!(gitCollection.json as Array<{ id: string }>).some((item) => item.id === temporaryGitBody.id));
    assert.ok(!(registryCollection.json as { items: Array<{ id: string }> }).items.some((item) => item.id === temporaryRegistryBody.id));
    assertRedacted(gitCollection.json);
    assertRedacted(registryCollection.json);
  } else if (phase === "exercise") {
    assert.ok(state.gitProviderId && state.exactRegistryId && state.defaultRegistryId);
    const activate = async (id: string, version: number) => api("POST", `/api/v1/admin/registries/${id}/activate`, undefined,
      { "if-match": `"registry-v${version}"` });
    const exact = await activate(state.exactRegistryId, state.exactRegistryVersion!);
    const fallback = await activate(state.defaultRegistryId, state.defaultRegistryVersion!);
    const exactView = exact.json as { configVersion: number };
    const fallbackView = fallback.json as { configVersion: number };
    await api("POST", `/api/v1/admin/registries/${state.defaultRegistryId}/default`, undefined,
      { "if-match": `"registry-v${fallbackView.configVersion}"` });
    await api("POST", "/api/v1/admin/registry-scopes", {
      scope: "@gate", connectionId: state.exactRegistryId,
    }, {}, [204]);
    state.exactRegistryVersion = exactView.configVersion;

    const connection = await api("POST", "/api/v1/me/git-connections", {
      providerId: state.gitProviderId,
      token: required("NURITEO_GATE_GIT_TOKEN"),
    }, {}, [201]);
    state.gitConnectionId = (connection.json as { id: string }).id;
    const imported = await api("POST", `/api/v1/projects/${state.projectId}/git/import`, {
      repositoryUrl: required("NURITEO_GATE_GIT_REPOSITORY_URL"), branch: "main",
    }, {}, [201]);
    assert.match(imported.etag ?? "", /^"git-remote-[0-9a-f]{40,64}"$/u);
    await providerCommit("pull-advance");
    const pulled = await api("POST", `/api/v1/projects/${state.projectId}/git/pull`, undefined,
      { "if-match": imported.etag! });
    const pushed = await api("POST", `/api/v1/projects/${state.projectId}/git/commit-push`,
      { commitMessage: "GATE-005 live commit" }, { "if-match": pulled.etag! });
    await providerCommit("non-fast-forward");
    const conflict = await api("POST", `/api/v1/projects/${state.projectId}/git/commit-push`,
      { commitMessage: "must not force" }, { "if-match": pushed.etag! }, [412]);
    assert.equal(conflict.status, 412);
  } else if (phase === "disable-exact") {
    assert.ok(state.exactRegistryId && state.exactRegistryVersion);
    const disabled = await api("POST", `/api/v1/admin/registries/${state.exactRegistryId}/disable`, undefined,
      { "if-match": `"registry-v${state.exactRegistryVersion}"` });
    state.exactRegistryVersion = (disabled.json as { configVersion: number }).configVersion;
  } else {
    throw new Error(`unsupported phase ${phase}`);
  }
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

  async function caLifecycle(type: "git_provider" | "registry", id: string) {
    const path = `/api/v1/admin/integrations/${type}/${id}/ca`;
    const current = await api("GET", path);
    const currentBody = current.json as { version: number };
    assert.equal(current.cacheControl, "no-store");
    assertRedacted(current.json);
    assert.equal(current.etag, `"integration-ca-v${currentBody.version}"`);
    const candidate = await api("POST", `${path}/candidates`, { pem: providerCa }, {
      "if-match": `"integration-ca-v${currentBody.version}"`,
      "idempotency-key": `gate005-${type}-${id}-stage`,
    }, [201]);
    const candidateBody = candidate.json as { id: string; state: string; version: number };
    assert.equal(candidateBody.state, "candidate");
    assert.equal(candidate.etag, `"integration-ca-v${candidateBody.version}"`);
    const active = await api("POST", `${path}/candidates/${candidateBody.id}/activate`, undefined, {
      "if-match": `"integration-ca-v${candidateBody.version}"`,
      "idempotency-key": `gate005-${type}-${id}-activate`,
    });
    const activeBody = active.json as { state: string; version: number };
    assert.equal(activeBody.state, "active");
    assert.equal(active.etag, `"integration-ca-v${activeBody.version}"`);
    assert.equal(active.cacheControl, "no-store");
    assertRedacted(active.json);
  }
} finally {
  await browser.close();
}

function providerCommit(value: string): Promise<void> {
  const url = new URL("/__commit", required("NURITEO_GATE_GIT_CONTROL_URL"));
  const ca = fs.readFileSync(required("NURITEO_GATE_PROVIDER_CA_FILE"));
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "POST", ca, headers: { "content-length": Buffer.byteLength(value) } }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 204 ? resolve() : reject(new Error(`fixture commit ${response.statusCode}`)));
    });
    request.once("error", reject);
    request.end(value);
  });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertRedacted(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.ok(!/BEGIN (?:RSA |EC )?PRIVATE KEY|"(?:clientSecret|password|plaintext|privateKey|secret|token)"\s*:/iu.test(serialized),
    `administrative response exposed a protected field: ${serialized}`);
}
