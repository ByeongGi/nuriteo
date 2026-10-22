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
import { useDeferredValue, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { TextField } from "#src/components/ui/field.tsx";
import { NumberField } from "#src/components/ui/number-field.tsx";
import { SegmentedControl } from "#src/components/ui/segmented-control.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

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

export interface AccessTokenConsoleProps {
  readonly initialTokens: readonly AccessToken[];
  readonly referenceTime?: number;
  readonly target: AccessTokenTarget;
}

export function AccessTokenConsole({ initialTokens, referenceTime, target }: AccessTokenConsoleProps) {
  const mutation = useExclusiveMutation();
  const [tokens, setTokens] = useState(initialTokens);
  const [issued, setIssued] = useState<IssuedAccessToken>();
  const [pendingAction, setPendingAction] = useState<PendingTokenAction>();
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [statusFilter, setStatusFilter] = useState<"all" | AccessToken["status"]>("all");
  const [now] = useState(() => referenceTime ?? Date.now());
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleTokens = useMemo(() => tokens.filter((token) => (
    (statusFilter === "all" || token.status === statusFilter)
    && (normalizedQuery === "" || `${token.name} ${token.prefix} ${token.scopes.join(" ")}`.toLocaleLowerCase("ko-KR").includes(normalizedQuery))
  )), [normalizedQuery, statusFilter, tokens]);
  const activeTokens = useMemo(() => tokens.filter((token) => token.status === "active"), [tokens]);
  const usedTokenCount = useMemo(
    () => activeTokens.reduce((count, token) => count + (token.lastUsedAt === null ? 0 : 1), 0),
    [activeTokens]
  );
  const nearestExpiryDays = useMemo(() => activeTokens.length === 0
    ? null
    : Math.max(0, Math.ceil((Math.min(...activeTokens.map((token) => new Date(token.expiresAt).getTime())) - now) / 86_400_000)), [activeTokens, now]);

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
        setFeedback({ error: false, text: `${token.name} 토큰을 즉시 폐기했습니다.` });
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
      setFeedback({ error: false, text: "토큰을 복사했습니다. 지금 안전한 자격 증명 관리 도구에 보관하세요." });
    } catch {
      setFeedback({ error: true, text: "복사하지 못했습니다. 토큰 값을 선택해 직접 복사하세요." });
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
        <p className="eyebrow">{target.kind === "personal" ? "개인 자동화" : "프로젝트 자동화"}</p>
        <h1>액세스 토큰</h1>
        <p>필요한 권한만 가진 자격 증명을 발급하세요. 누리터는 토큰 값을 한 번만 표시하고 해시만 저장합니다.</p>
      </header>

      <nav className="access-token-context" aria-label="토큰 적용 범위">
        <Link href="/access-tokens" aria-current={target.kind === "personal" ? "page" : undefined}>개인 토큰</Link>
        {target.kind === "project" ? <span>프로젝트 {target.projectId}</span> : <span>프로젝트 토큰은 프로젝트 상세 화면에서 관리할 수 있습니다.</span>}
      </nav>

      <section className="product-metrics" aria-label="액세스 토큰 요약">
        <article><span>활성 토큰</span><strong>{activeTokens.length}</strong><small>{target.kind === "personal" ? "개인 자동화 자격 증명" : "프로젝트 자동화 자격 증명"}</small></article>
        <article><span>최근 사용 기록</span><strong>{usedTokenCount}</strong><small>한 번 이상 사용된 활성 토큰</small></article>
        <article><span>가장 가까운 만료</span><strong>{nearestExpiryDays === null ? "—" : `${nearestExpiryDays}일`}</strong><small>만료 전에 교체를 준비하세요</small></article>
      </section>

      {issued === undefined ? null : (
        <section className="access-token-secret" aria-labelledby="issued-token-title">
          <div><p className="eyebrow">한 번만 표시</p><h2 id="issued-token-title">지금 토큰을 복사하세요</h2><p>이 화면을 벗어나면 토큰 값을 다시 확인할 수 없습니다.</p></div>
          <code>{issued.plaintext}</code>
          <div className="access-token-actions">
            <Button type="button" variant="primary" onClick={() => void copyIssued()}>토큰 복사</Button>
            <Button type="button" onClick={() => setIssued(undefined)}>안전하게 저장했습니다</Button>
          </div>
        </section>
      )}

      <section className="access-token-issue" aria-labelledby="issue-token-title">
        <div><p className="eyebrow">최소 권한 원칙</p><h2 id="issue-token-title">새 토큰 발급</h2><p>발급·교체·폐기 작업에는 최근에 인증한 세션이 필요합니다.</p></div>
        <form className="collaboration-form" onSubmit={issue} aria-busy={mutation.isPending}>
          <TextField label="토큰 이름" name="name" placeholder="preview-deploy" required maxLength={120} disabled={mutation.isPending} description="사용 목적이 드러나는 이름을 권장합니다." />
          <NumberField label="만료 기간(일)" name="expiryDays" min={1} max={365} defaultValue={30} disabled={mutation.isPending} description="30일을 권장하며 최대 365일까지 설정할 수 있습니다." />
          <fieldset className="access-token-scopes"><legend>권한 범위 <small>하나 이상 선택</small></legend>{SCOPES.map((scope) => <CheckboxField key={scope} name="scope" value={scope} label={<code>{scope}</code>} description={SCOPE_DESCRIPTIONS[scope]} disabled={mutation.isPending} />)}</fieldset>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "처리 중…" : "토큰 발급"}</Button>
        </form>
      </section>

      <section className="access-token-list" aria-labelledby="token-list-title">
        <div><p className="eyebrow">자격 증명 목록</p><h2 id="token-list-title">발급된 토큰 <small>{visibleTokens.length} / {tokens.length}</small></h2><p>사용하지 않는 토큰은 즉시 폐기하세요.</p></div>
        <section className="product-toolbar" aria-label="토큰 검색 및 상태 필터">
          <label className="product-search"><span aria-hidden="true">⌕</span><span className="sr-only">토큰 검색</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="이름, 접두사 또는 권한 검색" /></label>
          <SegmentedControl
            aria-label="토큰 상태"
            value={statusFilter}
            onValueChange={setStatusFilter}
            options={[
              { value: "all", label: `전체 ${tokens.length}` },
              { value: "active", label: `활성 ${activeTokens.length}` },
              { value: "expired", label: "만료" },
              { value: "revoked", label: "폐기됨" }
            ]}
          />
        </section>
        {visibleTokens.length === 0 ? <div className="access-token-empty"><strong>{tokens.length === 0 ? "발급된 토큰이 없습니다." : "검색 결과가 없습니다."}</strong><p>{tokens.length === 0 ? "위 양식에서 필요한 권한만 선택해 첫 토큰을 발급하세요." : "다른 검색어나 상태를 선택해보세요."}</p></div> : (
          <ul className="record-list" aria-busy={query !== deferredQuery}>
            {visibleTokens.map((token) => <li key={token.id}>
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
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "서버에서 작업을 완료했을 수 있습니다. 다시 시도하기 전에 토큰 목록을 새로고침하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "최근 재인증과 충분한 권한이 필요합니다. 다시 로그인한 뒤 시도하세요." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "이 토큰 또는 프로젝트가 더 이상 활성 상태가 아닙니다. 페이지를 새로고침하세요." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: "이름, 권한 범위와 만료 기간을 확인하세요. 관리자가 더 짧은 최대 만료 기간을 설정했을 수 있습니다." };
  return { error: true, text: "토큰 서비스를 일시적으로 사용할 수 없습니다. 이 페이지에는 토큰 원문을 남기지 않았습니다." };
}
