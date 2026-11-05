"use client";

import { useDeferredValue, useMemo, useState } from "react";

import { calculateExpiryDays } from "@/app/(authenticated)/account/tokens/_hooks/use-token-issue-form.ts";
import { accessTokenScopes, issueAccessTokenSchema } from "@/app/(authenticated)/account/tokens/_schema/access-token.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { issueAccessToken, revokeAccessToken, rotateAccessToken } from "@/services/access-tokens/api.ts";
import { ApiError } from "@/services/http/api.ts";

import type { AccessToken, AccessTokenTarget, IssuedAccessToken } from "@nuriteo/api-client";
import type { FormEvent } from "react";

type PendingTokenAction = Readonly<{
  action: "revoke" | "rotate";
  token: AccessToken;
}>;

export function useAccessTokenConsole(initialTokens: readonly AccessToken[], target: AccessTokenTarget) {
  const mutation = useExclusiveMutation();
  const [tokens, setTokens] = useState(initialTokens);
  const [issued, setIssued] = useState<IssuedAccessToken>();
  const [isIssuing, setIsIssuing] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingTokenAction>();
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [statusFilter, setStatusFilter] = useState<"all" | AccessToken["status"]>("all");
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleTokens = useMemo(() => tokens.filter((token) => (
    (statusFilter === "all" || token.status === statusFilter)
    && (normalizedQuery === "" || `${token.name} ${token.prefix} ${token.scopes.join(" ")}`.toLocaleLowerCase("ko-KR").includes(normalizedQuery))
  )), [normalizedQuery, statusFilter, tokens]);
  const activeTokens = useMemo(() => tokens.filter((token) => token.status === "active"), [tokens]);

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const scopes = accessTokenScopes.filter((scope) => data.getAll("scope").includes(scope));
    const selectedExpiryDays = calculateExpiryDays(String(data.get("expiresOn") ?? ""));
    const parsed = issueAccessTokenSchema.safeParse({
      name: String(data.get("name") ?? ""),
      scopes,
      selectedExpiryDays
    });
    if (!parsed.success) {
      setFeedback({
        error: true,
        text: parsed.error.issues[0]?.message ?? "이름, 권한 범위와 만료 기간을 확인하세요. 관리자가 더 짧은 최대 만료 기간을 설정했을 수 있습니다."
      });
      return;
    }
    const expiryDays = Math.max(1, parsed.data.selectedExpiryDays);
    await mutation.run(async () => {
      setFeedback(undefined);
      setIssued(undefined);
      try {
        const result = await issueAccessToken(createBrowserApiClient(), target, {
          name: parsed.data.name,
          scopes: parsed.data.scopes,
          expiryDays
        }, { csrfToken: readCsrfCredential() });
        setTokens((current) => [result.data.token, ...current]);
        setIssued(result.data);
        setIsIssuing(false);
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
        setTokens((current) => current.map((candidate) => candidate.id === token.id ? result.data : candidate));
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

  return {
    activeTokens,
    confirmPendingAction,
    copyIssued,
    feedback,
    isFiltering: query !== deferredQuery,
    isIssuing,
    isPending: mutation.isPending,
    issue,
    issued,
    pendingAction,
    query,
    setIsIssuing,
    setIssued,
    setPendingAction,
    setQuery,
    setStatusFilter,
    showFilters: tokens.length >= 8,
    statusFilter,
    tokens,
    visibleTokens
  };
}

function tokenFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "서버에서 작업을 완료했을 수 있습니다. 다시 시도하기 전에 토큰 목록을 새로고침하세요." };
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { error: true, text: "보안을 위해 다시 로그인한 뒤 토큰 작업을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "이 토큰 작업을 수행할 권한이 없습니다." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "이 토큰 또는 프로젝트가 더 이상 활성 상태가 아닙니다. 페이지를 새로고침하세요." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: "이름, 권한 범위와 만료 기간을 확인하세요. 관리자가 더 짧은 최대 만료 기간을 설정했을 수 있습니다." };
  return { error: true, text: "토큰 서비스를 일시적으로 사용할 수 없습니다. 이 페이지에는 토큰 원문을 남기지 않았습니다." };
}
