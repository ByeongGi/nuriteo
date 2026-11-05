"use client";

import type { AccessToken, AccessTokenScope, AccessTokenTarget } from "@nuriteo/api-client";
import type { FormEvent } from "react";

import { tokenConsoleStyles } from "@/app/(authenticated)/account/tokens/_components/token-console.styles.ts";
import { useAccessTokenConsole } from "@/app/(authenticated)/account/tokens/_hooks/use-token-console.ts";
import { useTokenIssueForm } from "@/app/(authenticated)/account/tokens/_hooks/use-token-issue-form.ts";
import { accessTokenScopes, type AccessTokenScopePreset } from "@/app/(authenticated)/account/tokens/_schema/access-token.ts";
import { Button } from "@/components/ui/button.tsx";
import { CheckboxField } from "@/components/ui/checkbox.tsx";
import { CollapsibleContent, CollapsibleIndicator, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog.tsx";
import { DatePickerField } from "@/components/ui/date-picker-field.tsx";
import { SelectField, TextField } from "@/components/ui/field.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { SearchField } from "@/components/ui/search-field.tsx";

const SCOPE_DESCRIPTIONS: Readonly<Record<AccessTokenScope, string>> = {
  "project:read": "프로젝트와 파일 조회",
  "project:write": "프로젝트 콘텐츠 변경",
  "project:publish": "공개 예제 배포",
  "project:manage": "프로젝트 설정과 권한 관리",
  "git:read": "Git 상태와 기록 조회",
  "git:write": "Git 변경사항 반영"
};

const SCOPE_PRESET_OPTIONS = [
  { value: "read", label: "읽기 전용" },
  { value: "development", label: "개발 (권장)" },
  { value: "deployment", label: "개발 및 배포" },
  { value: "administration", label: "전체 관리" },
  { value: "custom", label: "세부 권한 직접 선택" }
] as const;

const SCOPE_PRESET_DESCRIPTIONS: Readonly<Record<AccessTokenScopePreset, string>> = {
  read: "프로젝트와 Git 저장소를 조회할 수 있습니다.",
  development: "프로젝트 파일과 Git 변경사항을 읽고 수정할 수 있습니다.",
  deployment: "개발 권한과 공개 예제 배포 권한을 포함합니다.",
  administration: "프로젝트 설정을 포함한 모든 권한을 부여합니다.",
  custom: "필요한 세부 권한만 직접 선택합니다."
};

export interface AccessTokenConsoleProps {
  readonly embedded?: boolean;
  readonly initialTokens: readonly AccessToken[];
  readonly referenceTime?: number;
  readonly target: AccessTokenTarget;
}

export function AccessTokenConsole({ embedded = false, initialTokens, target }: AccessTokenConsoleProps) {
  const styles = tokenConsoleStyles({ embedded });
  const Root = embedded ? "div" : "main";
  const {
    activeTokens,
    confirmPendingAction,
    copyIssued,
    feedback,
    isFiltering,
    isIssuing,
    isPending,
    issue,
    issued,
    pendingAction,
    query,
    setIsIssuing,
    setIssued,
    setPendingAction,
    setQuery,
    setStatusFilter,
    showFilters,
    statusFilter,
    tokens,
    visibleTokens
  } = useAccessTokenConsole(initialTokens, target);

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
          pending={isPending}
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
          <ul className={styles.list()} aria-busy={isFiltering}>
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
        return (<div className={styles.recordActions()}><Button type="button" size="sm" disabled={isPending} onClick={() => setPendingAction({ action: "rotate", token })}>교체</Button><Button type="button" size="sm" variant="danger" disabled={isPending} onClick={() => setPendingAction({ action: "revoke", token })}>폐기</Button></div>);
    }
    return (null);
})()}
            </li>)}
          </ul>
        ));
})()}
      </section>}
      <ConfirmationDialog
        busy={isPending}
        confirmLabel={isPending ? "처리 중…" : (function () {
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
  const {
    advancedOpen,
    expiresOn,
    expiryDescription,
    expiryWindow,
    scopePreset,
    scopes,
    selectScopePreset,
    setAdvancedOpen,
    setExpiresOn,
    toggleScope
  } = useTokenIssueForm();

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
          description={expiryDescription}
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
                {accessTokenScopes.map((scope) => <CheckboxField appearance="card" checked={scopes.includes(scope)} key={scope} label={<code>{scope}</code>} description={SCOPE_DESCRIPTIONS[scope]} disabled={pending} onCheckedChange={(checked) => toggleScope(scope, checked)} />)}
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function tokenStatusLabel(status: AccessToken["status"]): string {
  if (status === "revoked") return "폐기됨";
  if (status === "expired") return "만료됨";
  return "활성";
}
