import assert from "node:assert/strict";

import { forwardCollaborationMutation } from "../src/lib/api/collaboration-bff.ts";

const PROJECT_ID = "0199ee6c-c777-7000-8000-000000090003";
const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ORIGIN = "https://nuriteo.example.test";
const CSRF = "nrt_csrf_git-bff";
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  await forwardsOnlyBrowserSecurityHeaders();
  await forwardsGitProviderAdminLifecycle();
  await rejectsWrongEtagAndCrossOrigin();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

async function forwardsGitProviderAdminLifecycle(): Promise<void> {
  let upstreamHeaders = new Headers();
  let upstreamUrl = "";
  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input);
    upstreamHeaders = new Headers(init?.headers);
    return Response.json({ ok: true }, { headers: { etag: '"git-provider-v8"' } });
  };
  const path = `/api/v1/admin/git-providers/${PROJECT_ID}/activate` as const;
  const response = await forwardCollaborationMutation(request(path, '"git-provider-v7"'), {
    etagKind: "git-provider",
    method: "POST",
    path,
    requireCsrf: true,
    withBody: false,
    withEtag: true
  });
  assert.equal(upstreamUrl, `http://core.internal:8080${path}`);
  assert.equal(upstreamHeaders.get("origin"), ORIGIN);
  assert.equal(upstreamHeaders.get("x-csrf-token"), CSRF);
  assert.equal(upstreamHeaders.get("if-match"), '"git-provider-v7"');
  assert.equal(upstreamHeaders.get("authorization"), null);
  assert.equal(upstreamHeaders.get("x-git-token"), null);
  assert.equal(response.headers.get("etag"), '"git-provider-v8"');
}

async function forwardsOnlyBrowserSecurityHeaders(): Promise<void> {
  let upstreamHeaders = new Headers();
  let upstreamUrl = "";
  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input);
    upstreamHeaders = new Headers(init?.headers);
    return Response.json({ ok: true }, { headers: { etag: `"git-remote-${SHA}"` } });
  };
  const path = `/api/v1/projects/${PROJECT_ID}/git/commit-push` as const;
  const response = await forwardCollaborationMutation(request(path, `"git-remote-${SHA}"`), {
    commitOutcomeUnknown: true,
    etagKind: "git-remote",
    method: "POST",
    path,
    requireCsrf: true,
    withBody: true,
    withEtag: true
  });
  assert.equal(upstreamUrl, `http://core.internal:8080${path}`);
  assert.equal(upstreamHeaders.get("origin"), ORIGIN);
  assert.equal(upstreamHeaders.get("cookie"), "nrt_session=opaque");
  assert.equal(upstreamHeaders.get("x-csrf-token"), CSRF);
  assert.equal(upstreamHeaders.get("if-match"), `"git-remote-${SHA}"`);
  assert.equal(upstreamHeaders.get("authorization"), null);
  assert.equal(upstreamHeaders.get("x-git-token"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

async function rejectsWrongEtagAndCrossOrigin(): Promise<void> {
  let dispatched = false;
  globalThis.fetch = async () => {
    dispatched = true;
    return new Response();
  };
  const path = `/api/v1/projects/${PROJECT_ID}/git/pull` as const;
  const wrong = await forwardCollaborationMutation(request(path, '"project-v2"'), {
    etagKind: "git-remote",
    method: "POST",
    path,
    requireCsrf: true,
    withBody: false,
    withEtag: true
  });
  assert.equal(wrong.status, 428);
  const wrongProvider = await forwardCollaborationMutation(
    request(`/api/v1/admin/git-providers/${PROJECT_ID}/disable`, 'W/"git-provider-v2"'),
    {
      etagKind: "git-provider",
      method: "POST",
      path: `/api/v1/admin/git-providers/${PROJECT_ID}/disable`,
      requireCsrf: true,
      withBody: false,
      withEtag: true
    }
  );
  assert.equal(wrongProvider.status, 428);
  const crossOrigin = await forwardCollaborationMutation(
    request(path, `"git-remote-${SHA}"`, "https://attacker.example.test"),
    {
      etagKind: "git-remote",
      method: "POST",
      path,
      requireCsrf: true,
      withBody: false,
      withEtag: true
    }
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(dispatched, false);
}

function request(path: string, etag: string, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}${path}`, {
    ...(path.endsWith("commit-push") ? { body: JSON.stringify({ commitMessage: "Update" }) } : {}),
    headers: {
      authorization: "Bearer browser-secret-must-not-forward",
      cookie: "nrt_session=opaque",
      host: "nuriteo.example.test",
      origin,
      "content-type": "application/json",
      "if-match": etag,
      "x-csrf-token": CSRF,
      "x-git-token": "must-not-forward"
    },
    method: "POST"
  });
}
