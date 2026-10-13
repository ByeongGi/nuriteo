"use client";

import {
  ApiError,
  issueAccessToken,
  revokeAccessToken,
  rotateAccessToken
} from "@nuriteo/api-client";
import type {
  AccessToken,
  AccessTokenScope,
  AccessTokenTarget,
  IssuedAccessToken
} from "@nuriteo/api-client";
import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../lib/use-exclusive-mutation.ts";

const SCOPES: readonly AccessTokenScope[] = [
  "project:read", "project:write", "project:publish", "project:manage", "git:read", "git:write"
];

export function AccessTokenConsole({ initialTokens, target }: {
  readonly initialTokens: readonly AccessToken[];
  readonly target: AccessTokenTarget;
}) {
  const mutation = useExclusiveMutation();
  const [tokens, setTokens] = useState(initialTokens);
  const [issued, setIssued] = useState<IssuedAccessToken>();
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const scopes = SCOPES.filter((scope) => data.getAll("scope").includes(scope));
    const expiry = String(data.get("expiryDays") ?? "").trim();
    await mutation.run(async () => {
      setFeedback(undefined);
      setIssued(undefined);
      try {
        const result = await issueAccessToken(createBrowserApiClient(), target, {
          name: String(data.get("name") ?? ""),
          scopes,
          ...(expiry === "" ? {} : { expiryDays: Number(expiry) })
        }, { csrfToken: readCsrfCredential() });
        setTokens((current) => [result.data.token, ...current]);
        setIssued(result.data);
        form.reset();
      } catch (error) {
        setFeedback(tokenFailure(error));
      }
    });
  }

  async function revoke(token: AccessToken) {
    await mutation.run(async () => {
      setFeedback(undefined);
      setIssued(undefined);
      try {
        const result = await revokeAccessToken(
          createBrowserApiClient(), target, token.id, { csrfToken: readCsrfCredential() }
        );
        replace(result.data);
        setFeedback({ error: false, text: `${token.name} was revoked immediately.` });
      } catch (error) {
        setFeedback(tokenFailure(error));
      }
    });
  }

  async function rotate(token: AccessToken) {
    await mutation.run(async () => {
      setFeedback(undefined);
      setIssued(undefined);
      try {
        const result = await rotateAccessToken(
          createBrowserApiClient(), target, token.id, undefined, { csrfToken: readCsrfCredential() }
        );
        setTokens((current) => [
          result.data.token,
          ...current.map((candidate) => candidate.id === token.id
            ? { ...candidate, status: "revoked" as const, revokedAt: new Date().toISOString() }
            : candidate)
        ]);
        setIssued(result.data);
      } catch (error) {
        setFeedback(tokenFailure(error));
      }
    });
  }

  function replace(token: AccessToken) {
    setTokens((current) => current.map((candidate) => candidate.id === token.id ? token : candidate));
  }

  async function copyIssued() {
    if (issued === undefined) return;
    try {
      await navigator.clipboard.writeText(issued.plaintext);
      setFeedback({ error: false, text: "Token copied. Store it in a secure credential manager now." });
    } catch {
      setFeedback({ error: true, text: "Copy failed. Select the token value and copy it manually." });
    }
  }

  return (
    <main id="main-content" className="workspace-page access-token-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">{target.kind === "personal" ? "Personal automation" : "Project automation"}</p>
        <h1>Access tokens</h1>
        <p>Issue narrowly scoped credentials. NURITEO shows a token value once and stores only its hash.</p>
      </header>

      <nav className="access-token-context" aria-label="Token context">
        <Link href="/access-tokens" aria-current={target.kind === "personal" ? "page" : undefined}>Personal tokens</Link>
        {target.kind === "project" ? <span>Project {target.projectId}</span> : <span>Open a Project to manage its Project tokens.</span>}
      </nav>

      {issued === undefined ? null : (
        <section className="access-token-secret" aria-labelledby="issued-token-title">
          <div><p className="eyebrow">Shown once</p><h2 id="issued-token-title">Copy this token now</h2></div>
          <code>{issued.plaintext}</code>
          <div className="access-token-actions">
            <Button type="button" variant="primary" onClick={() => void copyIssued()}>Copy token</Button>
            <Button type="button" onClick={() => setIssued(undefined)}>I stored it securely</Button>
          </div>
        </section>
      )}

      <section className="access-token-issue" aria-labelledby="issue-token-title">
        <div><p className="eyebrow">Least privilege</p><h2 id="issue-token-title">Issue a token</h2><p>Issuing, rotating, and revoking require a recently authenticated session.</p></div>
        <form className="collaboration-form" onSubmit={issue} aria-busy={mutation.isPending}>
          <label className="field-group">Token name<input name="name" required maxLength={120} disabled={mutation.isPending} /></label>
          <label className="field-group">Expiry in days <span>(optional)</span><input name="expiryDays" type="number" min="1" max="365" inputMode="numeric" disabled={mutation.isPending} /></label>
          <fieldset className="access-token-scopes"><legend>Scopes</legend>{SCOPES.map((scope) => <label key={scope}><input type="checkbox" name="scope" value={scope} disabled={mutation.isPending} /><span>{scope}</span></label>)}</fieldset>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "Working…" : "Issue token"}</Button>
        </form>
      </section>

      <section className="access-token-list" aria-labelledby="token-list-title">
        <div><p className="eyebrow">Credential inventory</p><h2 id="token-list-title">Tokens</h2></div>
        {tokens.length === 0 ? <p>No tokens have been issued in this context.</p> : (
          <ul className="record-list">
            {tokens.map((token) => <li key={token.id}>
              <div><strong>{token.name}</strong><span><code>{token.prefix}…</code> · {token.status} · expires {formatDate(token.expiresAt)}</span><small>{token.scopes.length === 0 ? "No scopes" : token.scopes.join(", ")}{token.lastUsedAt === null ? " · never used" : ` · last used ${formatDate(token.lastUsedAt)}`}</small></div>
              {token.status === "active" ? <div className="record-actions"><Button type="button" disabled={mutation.isPending} onClick={() => void rotate(token)}>Rotate</Button><Button type="button" variant="danger" disabled={mutation.isPending} onClick={() => void revoke(token)}>Revoke</Button></div> : null}
            </li>)}
          </ul>
        )}
      </section>
      {feedback ? <p className={`notification-feedback notification-feedback--${feedback.error ? "error" : "success"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function tokenFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "The server may have completed this change. Reload the token list before trying again." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "Recent reauthentication and sufficient access are required. Sign in again, then retry." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "This token or Project is no longer in an active state. Reload the page." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: "Review the name, scopes, and expiry. The administrator may enforce a lower maximum expiry." };
  return { error: true, text: "The token service is temporarily unavailable. No plaintext credential was retained by this page." };
}
