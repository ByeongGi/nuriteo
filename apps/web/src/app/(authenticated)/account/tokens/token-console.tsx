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
import { addDays, differenceInCalendarDays, isValid, parseISO, startOfDay } from "date-fns";
import { useDeferredValue, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { tokenConsoleStyles } from "#src/app/(authenticated)/account/tokens/token-console.styles.ts";
import { Button } from "#src/components/ui/button.tsx";
import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { CollapsibleContent, CollapsibleIndicator, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { DatePickerField } from "#src/components/ui/date-picker-field.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { SegmentedControl } from "#src/components/ui/segmented-control.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
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

const SCOPE_PRESETS = {
  read: ["project:read", "git:read"],
  development: ["project:read", "project:write", "git:read", "git:write"],
  deployment: ["project:read", "project:write", "project:publish", "git:read", "git:write"],
  administration: SCOPES
} as const satisfies Readonly<Record<string, readonly AccessTokenScope[]>>;

type ScopePreset = keyof typeof SCOPE_PRESETS | "custom";

const SCOPE_PRESET_OPTIONS = [
  { value: "read", label: "읽기 전용" },
  { value: "development", label: "개발 (권장)" },
  { value: "deployment", label: "개발 및 배포" },
  { value: "administration", label: "전체 관리" },
  { value: "custom", label: "세부 권한 직접 선택" }
] as const;

const SCOPE_PRESET_DESCRIPTIONS: Readonly<Record<ScopePreset, string>> = {
  read: "프로젝트와 Git 저장소를 조회할 수 있습니다.",
  development: "프로젝트 파일과 Git 변경사항을 읽고 수정할 수 있습니다.",
  deployment: "개발 권한과 공개 예제 배포 권한을 포함합니다.",
  administration: "프로젝트 설정을 포함한 모든 권한을 부여합니다.",
  custom: "필요한 세부 권한만 직접 선택합니다."
};

type PendingTokenAction = Readonly<{
  action: "revoke" | "rotate";
  token: AccessToken;
}>;

export interface AccessTokenConsoleProps {
  readonly embedded?: boolean;
  readonly initialTokens: readonly AccessToken[];
  readonly referenceTime?: number;
  readonly target: AccessTokenTarget;
}

export function AccessTokenConsole({ embedded = false, initialTokens, target }: AccessTokenConsoleProps) {
  const styles = tokenConsoleStyles({ embedded });
  const Root = embedded ? "div" : "main";
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
  const showFilters = tokens.length >= 8;

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const scopes = SCOPES.filter((scope) => data.getAll("scope").includes(scope));
    const selectedExpiryDays = calculateExpiryDays(String(data.get("expiresOn") ?? ""));
    if (scopes.length === 0) {
      setFeedback({ error: true, text: "토큰에 필요한 권한 범위를 하나 이상 선택하세요." });
      return;
    }
    if (selectedExpiryDays === undefined || selectedExpiryDays < 0 || selectedExpiryDays > 365) {
      setFeedback({ error: true, text: "만료일은 오늘부터 1년 이내로 선택하세요." });
      return;
    }
    const expiryDays = Math.max(1, selectedExpiryDays);
    await mutation.run(async () => {
      setFeedback(undefined);
      setIssued(undefined);
      try {
        const result = await issueAccessToken(createBrowserApiClient(), target, {
          name: String(data.get("name") ?? ""),
          scopes,
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
    <Root {...(embedded ? {} : { id: "main-content" })} className={styles.root()}>
      {embedded ? null : <PageHeader
        density="compact"
        eyebrow="계정"
        title="개인 토큰"
        description="CLI와 자동화에서 사용할 개인 액세스 토큰을 관리합니다."
        actions={(function () {
    if (isIssuing || issued !== undefined) {
        return (undefined);
    }
    return (<Button type="button" size="sm" variant="primary" onClick={() => setIsIssuing(true)}>새 토큰</Button>);
})()}
      />}

      {issued === undefined ? null : (
        <section className={styles.panel({ className: styles.secret() })} aria-labelledby="issued-token-title">
          <div className={styles.heading()}><p className={styles.eyebrow()}>한 번만 표시</p><h2 className={styles.title()} id="issued-token-title">지금 토큰을 복사하세요</h2><p className={styles.description()}>이 화면을 벗어나면 토큰 값을 다시 확인할 수 없습니다.</p></div>
          <code className={styles.secretCode()}>{issued.plaintext}</code>
          <div className={styles.actions()}>
            <Button type="button" size="sm" variant="primary" onClick={() => void copyIssued()}>토큰 복사</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setIssued(undefined)}>안전하게 저장했습니다</Button>
          </div>
        </section>
      )}

      {feedback ? <p className={styles.feedback({ className: (function () {
    if (feedback.error) {
        return (styles.feedbackError());
    }
    return (styles.feedbackSuccess());
})() })} role={(function () {
    if (feedback.error) {
        return ("alert");
    }
    return ("status");
})()}>{feedback.text}</p> : null}

      {isIssuing ? (
        <TokenIssueForm
          embedded={embedded}
          pending={mutation.isPending}
          onCancel={() => setIsIssuing(false)}
          onSubmit={issue}
        />
      ) : null}

      {isIssuing ? null : <section className={styles.panel()} aria-labelledby="token-list-title">
        <div className={styles.headingRow()}>
          <div className={styles.heading()}><h2 className={styles.title()} id="token-list-title">토큰 <small className={styles.titleCount()}>{tokens.length}</small></h2><p className={styles.description()}>사용하지 않는 토큰은 폐기하세요.</p></div>
          {(function () {
    if (embedded && issued === undefined) {
        return (<Button type="button" size="sm" variant="primary" onClick={() => setIsIssuing(true)}>새 토큰</Button>);
    }
    return (null);
})()}
        </div>
        {(function () {
    if (showFilters) {
        return (<section className={styles.toolbar()} aria-label="토큰 검색 및 상태 필터">
          <SearchField density="compact" className={styles.search()} label="토큰 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="이름, 접두사 또는 권한 검색" />
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
        </section>);
    }
    return (null);
})()}
        {(function () {
    if (visibleTokens.length === 0) {
        return (<div className={styles.empty()}><strong className={styles.emptyTitle()}>{(function () {
    if (tokens.length === 0) {
        return ("아직 토큰이 없습니다");
    }
    return ("검색 결과가 없습니다");
})()}</strong><p className={styles.emptyDescription()}>{(function () {
    if (tokens.length === 0) {
        return ("필요할 때 새 토큰을 만들어 CLI와 자동화에 연결할 수 있습니다.");
    }
    return ("다른 검색어나 상태를 선택해보세요.");
})()}</p></div>);
    }
    return ((
          <ul className={styles.list()} aria-busy={query !== deferredQuery}>
            {visibleTokens.map((token) => <li className={styles.item()} key={token.id}>
              <div className={styles.itemCopy()}><strong className={styles.itemTitle()}>{token.name}</strong><span className={styles.itemMeta()}><code>{token.prefix}…</code> · {tokenStatusLabel(token.status)} · {formatDate(token.expiresAt)} 만료</span><small className={styles.itemDetail()}>{(function () {
    if (token.scopes.length === 0) {
        return ("권한 없음");
    }
    return (token.scopes.join(", "));
})()}{(function () {
    if (token.lastUsedAt === null) {
        return (" · 사용 기록 없음");
    }
    return (` · 마지막 사용 ${formatDate(token.lastUsedAt)}`);
})()}</small></div>
              {(function () {
    if (token.status === "active") {
        return (<div className={styles.recordActions()}><Button type="button" size="sm" disabled={mutation.isPending} onClick={() => setPendingAction({ action: "rotate", token })}>교체</Button><Button type="button" size="sm" variant="danger" disabled={mutation.isPending} onClick={() => setPendingAction({ action: "revoke", token })}>폐기</Button></div>);
    }
    return (null);
})()}
            </li>)}
          </ul>
        ));
})()}
      </section>}
      <ConfirmationDialog
        busy={mutation.isPending}
        confirmLabel={mutation.isPending ? "처리 중…" : (function () {
    if (pendingAction?.action === "rotate") {
        return ("교체하고 새 토큰 보기");
    }
    return ("토큰 폐기");
})()}
        description={`${pendingAction?.token.name ?? "선택한 토큰"}을 사용하는 자동화는 기존 자격 증명으로 더 이상 접근할 수 없습니다.`}
        open={pendingAction !== undefined}
        title={pendingAction?.action === "rotate" ? "토큰을 교체할까요?" : "토큰을 폐기할까요?"}
        tone={pendingAction?.action === "revoke" ? "danger" : "primary"}
        onCancel={() => setPendingAction(undefined)}
        onConfirm={confirmPendingAction}
      />
    </Root>
  );
}

function TokenIssueForm({ embedded, pending, onCancel, onSubmit }: Readonly<{
  embedded: boolean;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}>) {
  const styles = tokenConsoleStyles({ embedded });
  const [expiryWindow] = useState(createExpiryWindow);
  const [expiresOn, setExpiresOn] = useState(expiryWindow.defaultValue);
  const [scopePreset, setScopePreset] = useState<ScopePreset>("development");
  const [scopes, setScopes] = useState<readonly AccessTokenScope[]>(SCOPE_PRESETS.development);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function selectScopePreset(nextPreset: string) {
    const preset = nextPreset as ScopePreset;
    setScopePreset(preset);
    if (preset === "custom") {
      setAdvancedOpen(true);
      return;
    }
    setScopes(SCOPE_PRESETS[preset]);
  }

  function toggleScope(scope: AccessTokenScope, checked: boolean) {
    setScopePreset("custom");
    setScopes((current) => checked
      ? SCOPES.filter((candidate) => candidate === scope || current.includes(candidate))
      : current.filter((candidate) => candidate !== scope));
  }

  return (
    <section className={styles.panel({ className: styles.issuePanel() })} aria-labelledby="issue-token-title">
      <div className={styles.heading()}>
        <h2 className={styles.title()} id="issue-token-title">새 토큰</h2>
        <p className={styles.description()}>이름과 만료 기간을 정하고 필요한 권한만 선택하세요.</p>
      </div>
      <form className={styles.form()} onSubmit={onSubmit} aria-busy={pending}>
        <TextField density="compact" label="토큰 이름" name="name" placeholder="예: preview-deploy" required maxLength={120} disabled={pending} />
        <DatePickerField
          density="compact"
          label="만료일"
          name="expiresOn"
          min={expiryWindow.min}
          max={expiryWindow.max}
          value={expiresOn}
          disabled={pending}
          description={formatExpiryDescription(expiresOn)}
          required
          onValueChange={setExpiresOn}
        />
        <SelectField
          className={styles.permissionPreset()}
          density="compact"
          label="사용 목적"
          value={scopePreset}
          options={SCOPE_PRESET_OPTIONS}
          description={SCOPE_PRESET_DESCRIPTIONS[scopePreset]}
          disabled={pending}
          onValueChange={selectScopePreset}
        />
        {scopes.map((scope) => <input key={scope} type="hidden" name="scope" value={scope} />)}
        <CollapsibleRoot className={styles.advancedPermissions()} open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger>
            <span>세부 권한</span>
            <span className={styles.advancedSummary()}>{scopes.length}개 선택 <CollapsibleIndicator>⌄</CollapsibleIndicator></span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <CollapsibleContent className={styles.advancedContent()}>
              <fieldset className={styles.scopes()}>
                <legend className="sr-only">세부 권한 직접 선택</legend>
                {SCOPES.map((scope) => <CheckboxField appearance="card" checked={scopes.includes(scope)} key={scope} label={<code>{scope}</code>} description={SCOPE_DESCRIPTIONS[scope]} disabled={pending} onCheckedChange={(checked) => toggleScope(scope, checked)} />)}
              </fieldset>
            </CollapsibleContent>
          </CollapsiblePanel>
        </CollapsibleRoot>
        <div className={styles.formActions()}>
          <Button type="button" size="sm" disabled={pending} onClick={onCancel}>취소</Button>
          <Button type="submit" size="sm" variant="primary" disabled={pending}>{pending ? "발급 중…" : "토큰 발급"}</Button>
        </div>
      </form>
    </section>
  );
}

function createExpiryWindow() {
  const today = startOfDay(new Date());
  return {
    min: today,
    max: addDays(today, 365),
    defaultValue: addDays(today, 30)
  };
}

function calculateExpiryDays(value: Date | string): number | undefined {
  const expiry = typeof value === "string" ? parseISO(value) : value;
  if (!isValid(expiry)) return undefined;
  return differenceInCalendarDays(expiry, startOfDay(new Date()));
}

function formatExpiryDescription(value: Date): string {
  const days = calculateExpiryDays(value);
  if (days === 0) return "오늘 발급 · 24시간 유효";
  return `${days ?? 0}일 후 만료`;
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
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { error: true, text: "보안을 위해 다시 로그인한 뒤 토큰 작업을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "이 토큰 작업을 수행할 권한이 없습니다." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "이 토큰 또는 프로젝트가 더 이상 활성 상태가 아닙니다. 페이지를 새로고침하세요." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: "이름, 권한 범위와 만료 기간을 확인하세요. 관리자가 더 짧은 최대 만료 기간을 설정했을 수 있습니다." };
  return { error: true, text: "토큰 서비스를 일시적으로 사용할 수 없습니다. 이 페이지에는 토큰 원문을 남기지 않았습니다." };
}
