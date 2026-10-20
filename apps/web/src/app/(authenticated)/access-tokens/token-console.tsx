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

const SCOPE_DESCRIPTIONS: Readonly<Record<AccessTokenScope, string>> = {
  "project:read": "프로젝트와 파일 조회",
  "project:write": "프로젝트 콘텐츠 변경",
  "project:publish": "공개 예제 배포",
  "project:manage": "프로젝트 설정과 권한 관리",
  "git:read": "Git 상태와 기록 조회",
  "git:write": "Git 변경사항 반영"
};

type PendingTokenAction = Readonly<{
  action: "revoke" | "rotate";
  token: AccessToken;
}>;

export function AccessTokenConsole({ initialTokens, target }: {
  readonly initialTokens: readonly AccessToken[];
  readonly target: AccessTokenTarget;
}) {
  const mutation = useExclusiveMutation();
  const [tokens, setTokens] = useState(initialTokens);
  const [issued, setIssued] = useState<IssuedAccessToken>();
  const [pendingAction, setPendingAction] = useState<PendingTokenAction>();
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const scopes = SCOPES.filter((scope) => data.getAll("scope").includes(scope));
    const expiry = String(data.get("expiryDays") ?? "").trim();
    if (scopes.length === 0) {
      setFeedback({ error: true, text: "토큰에 필요한 권한 범위를 하나 이상 선택하세요." });
      return;
    }
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
        setPendingAction(undefined);
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
        setPendingAction(undefined);
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
        setPendingAction(undefined);
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

  function confirmPendingAction() {
    if (pendingAction === undefined) return;
    if (pendingAction.action === "rotate") {
      void rotate(pendingAction.token);
      return;
    }
    void revoke(pendingAction.token);
  }

  return (
    <main id="main-content" className="workspace-page access-token-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">{target.kind === "personal" ? "Personal automation" : "Project automation"}</p>
        <h1>액세스 토큰</h1>
        <p>필요한 권한만 가진 자격 증명을 발급하세요. NURITEO shows a token value once and stores only its hash.</p>
      </header>

      <nav className="access-token-context" aria-label="Token context">
        <Link href="/access-tokens" aria-current={target.kind === "personal" ? "page" : undefined}>개인 토큰</Link>
        {target.kind === "project" ? <span>프로젝트 {target.projectId}</span> : <span>프로젝트 토큰은 프로젝트 상세 화면에서 관리할 수 있습니다.</span>}
      </nav>

      {issued === undefined ? null : (
        <section className="access-token-secret" aria-labelledby="issued-token-title">
          <div><p className="eyebrow">Shown once</p><h2 id="issued-token-title">지금 토큰을 복사하세요</h2><p>이 화면을 벗어나면 토큰 값을 다시 확인할 수 없습니다.</p></div>
          <code>{issued.plaintext}</code>
          <div className="access-token-actions">
            <Button type="button" variant="primary" onClick={() => void copyIssued()}>토큰 복사</Button>
            <Button type="button" onClick={() => setIssued(undefined)}>안전하게 저장했습니다</Button>
          </div>
        </section>
      )}

      <section className="access-token-issue" aria-labelledby="issue-token-title">
        <div><p className="eyebrow">LEAST PRIVILEGE</p><h2 id="issue-token-title">새 토큰 발급</h2><p>Issuing, rotating, and revoking require a recently authenticated session.</p></div>
        <form className="collaboration-form" onSubmit={issue} aria-busy={mutation.isPending}>
          <label className="field-group">토큰 이름<input name="name" placeholder="preview-deploy" required maxLength={120} disabled={mutation.isPending} /><small>사용 목적이 드러나는 이름을 권장합니다.</small></label>
          <label className="field-group">만료 기간 <span>(일)</span><input name="expiryDays" type="number" min="1" max="365" inputMode="numeric" defaultValue="30" disabled={mutation.isPending} /><small>30일을 권장하며 최대 365일까지 설정할 수 있습니다.</small></label>
          <fieldset className="access-token-scopes"><legend>권한 범위 <small>하나 이상 선택</small></legend>{SCOPES.map((scope) => <label key={scope}><input type="checkbox" name="scope" value={scope} disabled={mutation.isPending} /><span><code>{scope}</code><small>{SCOPE_DESCRIPTIONS[scope]}</small></span></label>)}</fieldset>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "처리 중…" : "토큰 발급"}</Button>
        </form>
      </section>

      <section className="access-token-list" aria-labelledby="token-list-title">
        <div><p className="eyebrow">CREDENTIAL INVENTORY</p><h2 id="token-list-title">발급된 토큰</h2><p>사용하지 않는 토큰은 즉시 폐기하세요.</p></div>
        {tokens.length === 0 ? <div className="access-token-empty"><strong>발급된 토큰이 없습니다.</strong><p>위 양식에서 필요한 권한만 선택해 첫 토큰을 발급하세요.</p></div> : (
          <ul className="record-list">
            {tokens.map((token) => <li key={token.id}>
              <div><strong>{token.name}</strong><span><code>{token.prefix}…</code> · {tokenStatusLabel(token.status)} · {formatDate(token.expiresAt)} 만료</span><small>{token.scopes.length === 0 ? "권한 없음" : token.scopes.join(", ")}{token.lastUsedAt === null ? " · 사용 기록 없음" : ` · 마지막 사용 ${formatDate(token.lastUsedAt)}`}</small></div>
              {token.status === "active" ? <div className="record-actions"><Button type="button" disabled={mutation.isPending} onClick={() => setPendingAction({ action: "rotate", token })}>교체</Button><Button type="button" variant="danger" disabled={mutation.isPending} onClick={() => setPendingAction({ action: "revoke", token })}>폐기</Button></div> : null}
            </li>)}
          </ul>
        )}
      </section>
      {pendingAction === undefined ? null : (
        <section className="access-token-confirmation" role="alertdialog" aria-labelledby="token-confirmation-title" aria-describedby="token-confirmation-description">
          <div><p className="eyebrow">확인 필요</p><h2 id="token-confirmation-title">{pendingAction.action === "rotate" ? "토큰을 교체할까요?" : "토큰을 폐기할까요?"}</h2><p id="token-confirmation-description"><strong>{pendingAction.token.name}</strong>을 사용하는 자동화는 기존 자격 증명으로 더 이상 접근할 수 없습니다.</p></div>
          <div className="access-token-actions"><Button type="button" onClick={() => setPendingAction(undefined)}>취소</Button><Button type="button" variant={pendingAction.action === "revoke" ? "danger" : "primary"} disabled={mutation.isPending} onClick={confirmPendingAction}>{mutation.isPending ? "처리 중…" : pendingAction.action === "rotate" ? "교체하고 새 토큰 보기" : "토큰 폐기"}</Button></div>
        </section>
      )}
      {feedback ? <p className={`notification-feedback notification-feedback--${feedback.error ? "error" : "success"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function tokenStatusLabel(status: AccessToken["status"]): string {
  if (status === "revoked") return "폐기됨";
  if (status === "expired") return "만료됨";
  return "활성";
}

function tokenFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "The server may have completed this change. Reload the token list before trying again." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "Recent reauthentication and sufficient access are required. Sign in again, then retry." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "This token or Project is no longer in an active state. Reload the page." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: "Review the name, scopes, and expiry. The administrator may enforce a lower maximum expiry." };
  return { error: true, text: "The token service is temporarily unavailable. No plaintext credential was retained by this page." };
}
