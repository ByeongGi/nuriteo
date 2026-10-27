"use client";

import { ApiError, activateGitProvider, createGitProvider, deleteGitProvider, disableGitProvider, updateGitProvider } from "@nuriteo/api-client";
import type { GitProviderAdmin, GitProviderKind } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Badge } from "#src/components/ui/badge.tsx";
import { buttonVariants } from "#src/components/ui/button.styles.ts";
import { Button } from "#src/components/ui/button.tsx";
import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminForm, AdminFormActionNote, AdminFormActions } from "#src/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminConnectionGuide } from "#src/app/(admin)/admin/_components/admin-connection-guide.tsx";
import { AdminIntegrationActionBar, AdminIntegrationBackLink, AdminIntegrationDangerSection, AdminIntegrationReadOnlyGrid, AdminIntegrationSection, AdminIntegrationSummary } from "#src/app/(admin)/admin/_components/admin-integration-detail.tsx";
import { AdminCollectionHeading, AdminFeedback, AdminIntegrationRecord, AdminPage, AdminPanel, AdminRecordActions, AdminSection } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

const PROVIDER_KIND_OPTIONS = [
  { value: "generic", label: "일반 HTTPS" },
  { value: "github", label: "GitHub" },
  { value: "github_enterprise", label: "GitHub Enterprise" },
  { value: "gitlab", label: "GitLab" },
  { value: "gitlab_self_managed", label: "자체 호스팅 GitLab" }
] as const;
import { IntegrationCaConsole } from "#src/app/(admin)/admin/_components/integration-ca-console.tsx";

export function GitProviderConsole({ createMode = false, detailMode = false, initialProviders }: { readonly createMode?: boolean; readonly detailMode?: boolean; readonly initialProviders: readonly GitProviderAdmin[] }) {
  const router = useRouter();
  const [providers, setProviders] = useState(initialProviders);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const [pendingDeletion, setPendingDeletion] = useState<GitProviderAdmin>();
  const mutation = useExclusiveMutation();
  const options = () => ({ csrfToken: readCsrfCredential() });
  const replace = (provider: GitProviderAdmin) => setProviders((items) => items.map((item) => item.id === provider.id ? provider : item));

  async function execute(action: () => Promise<GitProviderAdmin>, success: string) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try { replace(await action()); setFeedback({ error: false, text: success }); }
      catch (error) { setFeedback(failure(error)); }
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await createGitProvider(createBrowserApiClient(), input(data), options());
        setProviders((items) => [...items, result.data]);
        form.reset();
        setFeedback({ error: false, text: "제공자를 비활성 상태로 저장했습니다. 필요하면 사설 CA 신뢰를 구성한 뒤 검증하고 활성화하세요." });
        if (createMode) router.replace(`/admin/integrations/git/${result.data.id}`);
      } catch (error) { setFeedback(failure(error)); }
    });
  }

  if (createMode) return <GitProviderCreate busy={mutation.isPending} feedback={feedback} onSubmit={create} />;

  async function update(event: FormEvent<HTMLFormElement>, provider: GitProviderAdmin) {
    event.preventDefault();
    const value = input(new FormData(event.currentTarget));
    await execute(async () => (await updateGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, {
      displayName: value.displayName, apiBaseUrl: value.apiBaseUrl, oauthAuthorizationUrl: value.oauthAuthorizationUrl,
      oauthTokenUrl: value.oauthTokenUrl, oauthClientId: value.oauthClientId, allowsRead: value.allowsRead, allowsWrite: value.allowsWrite
    }, options())).data, "제공자 정보를 변경했습니다. 사용하기 전에 검증하세요.");
  }

  async function remove(provider: GitProviderAdmin) {
    await mutation.run(async () => {
      try { await deleteGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, options()); setProviders((items) => items.filter((item) => item.id !== provider.id)); setPendingDeletion(undefined); if (detailMode) router.replace("/admin/integrations/git"); }
      catch (error) { setFeedback(failure(error)); }
    });
  }

  const detailProvider = detailMode ? providers[0] : undefined;
  if (detailProvider) {
    return <GitProviderDetail
      provider={detailProvider}
      busy={mutation.isPending}
      feedback={feedback}
      pendingDeletion={pendingDeletion}
      onActivate={() => void execute(async () => (await activateGitProvider(createBrowserApiClient(), detailProvider.id, detailProvider.configVersion, options())).data, "제공자를 검증하고 활성화했습니다.")}
      onDelete={() => setPendingDeletion(detailProvider)}
      onDeleteCancel={() => setPendingDeletion(undefined)}
      onDeleteConfirm={() => void remove(detailProvider)}
      onDisable={() => void execute(async () => (await disableGitProvider(createBrowserApiClient(), detailProvider.id, detailProvider.configVersion, options())).data, "제공자를 즉시 비활성화했습니다.")}
      onUpdate={(event) => void update(event, detailProvider)}
    />;
  }

  return <AdminPage id="main-content" contentWidth="standard">
    <AdminPageHeader category="연동" title="Git 제공자" description="등록된 Git 연결의 상태, 권한과 검증 결과를 확인합니다." aside={<div className="flex items-center gap-2"><Badge>등록 {providers.length}개</Badge><Link className={buttonVariants({ size: "sm", variant: "primary" })} href="/admin/integrations/git/new">새 제공자</Link></div>} />
    <AdminPanel aria-labelledby="git-provider-list"><AdminCollectionHeading><h2 id="git-provider-list">등록된 제공자</h2><Badge>{providers.length}개</Badge></AdminCollectionHeading>{providers.length === 0 ? <p>등록된 Git 제공자가 없습니다. 새 제공자를 등록해 첫 연결을 구성하세요.</p> : <ul className="mt-6 grid list-none gap-2 p-0">{providers.map((provider) => <AdminIntegrationRecord key={provider.id}><div><strong>{provider.displayName}</strong><span>{(function () {
    if (provider.state === "active") {
        return ("활성");
    }
    return ("비활성");
})()} · {providerKindLabel(provider.kind)}</span><small>{provider.host}:{provider.port} · {(function () {
    if (provider.allowsWrite) {
        return ("읽기·쓰기");
    }
    return ("읽기 전용");
})()}</small></div><AdminRecordActions><Link className={buttonVariants({ size: "sm", variant: "secondary" })} href={`/admin/integrations/git/${provider.id}`}>상세 보기</Link></AdminRecordActions></AdminIntegrationRecord>)}</ul>}</AdminPanel>
    {feedback ? <AdminFeedback feedbackTone={(function () {
    if (feedback.error) {
        return ("danger");
    }
    return ("success");
})()} role={(function () {
    if (feedback.error) {
        return ("alert");
    }
    return ("status");
})()}>{feedback.text}</AdminFeedback> : null}
    <ConfirmationDialog busy={mutation.isPending} confirmLabel={mutation.isPending ? "삭제 중…" : "제공자 삭제"} description={`${pendingDeletion?.displayName ?? "선택한 제공자"} 설정과 인증서 신뢰 구성이 영구적으로 삭제됩니다.`} open={pendingDeletion !== undefined} title="Git 제공자를 삭제할까요?" onCancel={() => setPendingDeletion(undefined)} onConfirm={() => { if (pendingDeletion) void remove(pendingDeletion); }} />
  </AdminPage>;
}

interface GitProviderDetailProps {
  readonly busy: boolean;
  readonly feedback: { readonly error: boolean; readonly text: string } | undefined;
  readonly onActivate: () => void;
  readonly onDelete: () => void;
  readonly onDeleteCancel: () => void;
  readonly onDeleteConfirm: () => void;
  readonly onDisable: () => void;
  readonly onUpdate: (event: FormEvent<HTMLFormElement>) => void;
  readonly pendingDeletion: GitProviderAdmin | undefined;
  readonly provider: GitProviderAdmin;
}

function GitProviderCreate({ busy, feedback, onSubmit }: { readonly busy: boolean; readonly feedback: { readonly error: boolean; readonly text: string } | undefined; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <AdminPage id="main-content" contentWidth="narrow" aria-busy={busy}>
      <AdminIntegrationBackLink href="/admin/integrations/git">Git 제공자</AdminIntegrationBackLink>
      <AdminPageHeader category="Git 제공자" title="새 Git 제공자" description="연결 원본과 권한을 등록한 뒤 상세 화면에서 검증하고 활성화합니다." />
      <AdminConnectionGuide subject="Git 제공자" />
      <AdminPanel><ProviderForm onSubmit={onSubmit} disabled={busy} /></AdminPanel>
      {feedback ? <AdminFeedback feedbackTone={(function () {
    if (feedback.error) {
        return ("danger");
    }
    return ("success");
})()} role={(function () {
    if (feedback.error) {
        return ("alert");
    }
    return ("status");
})()}>{feedback.text}</AdminFeedback> : null}
    </AdminPage>
  );
}

function GitProviderDetail({ busy, feedback, onActivate, onDelete, onDeleteCancel, onDeleteConfirm, onDisable, onUpdate, pendingDeletion, provider }: GitProviderDetailProps) {
  const active = provider.state === "active";
  const permissions = provider.allowsWrite ? "읽기·쓰기" : (function () {
    if (provider.allowsRead) {
        return ("읽기 전용");
    }
    return ("권한 없음");
})();
  return (
    <AdminPage id="main-content" contentWidth="standard" aria-busy={busy}>
      <AdminIntegrationBackLink href="/admin/integrations/git">Git 제공자</AdminIntegrationBackLink>
      <AdminPageHeader
        category="Git 제공자"
        title={provider.displayName}
        description="저장소 연결 주소, 접근 범위와 검증 상태를 한곳에서 관리합니다."
        aside={<Badge tone={active ? "success" : "neutral"} variant="status">{active ? "활성" : "비활성"}</Badge>}
      />
      <AdminIntegrationSummary
        state={active ? "active" : "disabled"}
        title={active ? "프로젝트에서 이 Git 연결을 사용할 수 있습니다" : "프로젝트 연결에 아직 사용할 수 없습니다"}
        description={active ? "현재 설정은 잠겨 있습니다. 주소나 권한을 변경하려면 먼저 비활성화하세요." : "연결 정보와 접근 범위를 확인한 뒤 실제 네트워크 검증을 통과하면 활성화할 수 있습니다."}
        metrics={[
          { label: "제공자", value: providerKindLabel(provider.kind) },
          { label: "저장소 권한", value: permissions },
          { label: "최근 검증", value: formatValidationDate(provider.validatedAt) },
          { label: "설정 버전", value: `v${provider.configVersion}` }
        ]}
      />
      <AdminIntegrationSection title="연결 및 접근 범위" description="API 원본과 OAuth 애플리케이션, 저장소 권한을 관리합니다.">
        {active ? (
          <AdminIntegrationReadOnlyGrid items={[
            { label: "호스트", value: `${provider.host}:${provider.port}` },
            { label: "API 기본 URL", value: provider.apiBaseUrl },
            { label: "OAuth 클라이언트 ID", value: provider.oauthClientId ?? "사용하지 않음" },
            { label: "접근 권한", value: permissions }
          ]} />
        ) : <ProviderForm provider={provider} onSubmit={onUpdate} disabled={busy} />}
      </AdminIntegrationSection>
      <AdminIntegrationSection title="TLS 인증서 신뢰" description="자체 호스팅 Git 서버가 사설 인증 기관을 사용할 때만 등록하세요.">
        <IntegrationCaConsole appearance="detail" type="git_provider" integrationId={provider.id} />
      </AdminIntegrationSection>
      <AdminSection>
        <AdminIntegrationActionBar note={active ? "비활성화하면 새 프로젝트 연결과 원격 Git 작업이 중단될 수 있습니다." : "활성화 전에 HTTPS, API 응답, OAuth 설정과 인증서 신뢰를 실제로 검증합니다."}>
          {active ? <Button disabled={busy} onClick={onDisable}>Git 연결 비활성화</Button> : <Button variant="primary" disabled={busy} onClick={onActivate}>검증 후 활성화</Button>}
        </AdminIntegrationActionBar>
      </AdminSection>
      <AdminIntegrationDangerSection title="제공자 삭제" description="연결 설정과 인증서 신뢰 구성을 영구적으로 제거합니다. 먼저 제공자를 비활성화해야 합니다.">
        <Button variant="danger" disabled={busy || active} onClick={onDelete}>제공자 삭제</Button>
      </AdminIntegrationDangerSection>
      {feedback ? <AdminFeedback feedbackTone={(function () {
    if (feedback.error) {
        return ("danger");
    }
    return ("success");
})()} role={(function () {
    if (feedback.error) {
        return ("alert");
    }
    return ("status");
})()}>{feedback.text}</AdminFeedback> : null}
      <ConfirmationDialog busy={busy} confirmLabel={busy ? "삭제 중…" : "제공자 삭제"} description={`${provider.displayName} 설정과 인증서 신뢰 구성이 영구적으로 삭제됩니다.`} open={pendingDeletion !== undefined} title="Git 제공자를 삭제할까요?" onCancel={onDeleteCancel} onConfirm={onDeleteConfirm} />
    </AdminPage>
  );
}

function formatValidationDate(value: string | null): string {
  if (value === null) return "검증 기록 없음";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function ProviderForm({ provider, onSubmit, disabled }: { readonly provider?: GitProviderAdmin; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void; readonly disabled: boolean }) {
  const [kind, setKind] = useState<GitProviderKind>(provider?.kind ?? "generic");
  const preset = OFFICIAL_PROVIDER_PRESETS[kind as keyof typeof OFFICIAL_PROVIDER_PRESETS];
  const isSelfHosted = kind === "github_enterprise" || kind === "gitlab_self_managed";
  const usesOAuth = kind !== "generic";

  return (
    <AdminForm onSubmit={onSubmit} aria-busy={disabled}>
      <section className="col-span-full grid grid-cols-2 gap-4 border-t border-muted-border pt-5 first:border-t-0 first:pt-0 max-[48rem]:grid-cols-1" aria-labelledby={provider ? `provider-basic-${provider.id}` : "provider-basic-new"}>
        <header className="col-span-full grid gap-1 [&_strong]:text-sm [&_strong]:text-foreground [&_span]:text-xs [&_span]:text-subtle-foreground">
          <strong id={provider ? `provider-basic-${provider.id}` : "provider-basic-new"}>기본 정보</strong>
          <span>관리 화면과 연결 선택기에 표시되는 정보를 설정합니다.</span>
        </header>
        <TextField label="표시 이름" name="displayName" defaultValue={provider?.displayName} required maxLength={200} disabled={disabled} />
        {provider ? (
          <div className="grid min-w-0 gap-1 rounded-md border border-muted-border bg-subtle px-4 py-3 [&_span]:text-xs [&_span]:text-subtle-foreground [&_strong]:[overflow-wrap:anywhere]">
            <span>제공자 종류</span>
            <strong>{providerKindLabel(kind)}</strong>
          </div>
        ) : (
          <SelectField label="제공자 종류" name="kind" options={PROVIDER_KIND_OPTIONS} value={kind} disabled={disabled} onValueChange={(nextValue) => setKind(nextValue as GitProviderKind)} />
        )}
      </section>

      <section className="col-span-full grid grid-cols-2 gap-4 border-t border-muted-border pt-5 first:border-t-0 first:pt-0 max-[48rem]:grid-cols-1" aria-labelledby={provider ? `provider-connection-${provider.id}` : "provider-connection-new"}>
        <header className="col-span-full grid gap-1 [&_strong]:text-sm [&_strong]:text-foreground [&_span]:text-xs [&_span]:text-subtle-foreground">
          <strong id={provider ? `provider-connection-${provider.id}` : "provider-connection-new"}>연결 정보</strong>
          <span>{preset ? "공식 서비스 주소를 안전한 기본값으로 사용합니다." : "서버가 검증할 정확한 HTTPS 원본을 입력합니다."}</span>
        </header>
        {preset ? (
          <>
            <div className="col-span-full grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,1.4fr)] gap-3 rounded-md border border-muted-border bg-subtle px-4 py-3 max-[48rem]:col-auto max-[48rem]:grid-cols-1 [&>span]:grid [&>span]:min-w-0 [&>span]:gap-1 [&_small]:text-xs [&_small]:text-subtle-foreground [&_strong]:[overflow-wrap:anywhere]">
              <span><small>호스트</small><strong>{preset.host}</strong></span>
              <span><small>포트</small><strong>{preset.port}</strong></span>
              <span><small>API</small><strong>{preset.apiBaseUrl}</strong></span>
            </div>
            <input type="hidden" name="host" value={preset.host} />
            <input type="hidden" name="port" value={preset.port} />
            <input type="hidden" name="apiBaseUrl" value={preset.apiBaseUrl} />
          </>
        ) : (function () {
    if (provider) {
        return ((
          <div className="col-span-full grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,1.4fr)] gap-3 rounded-md border border-muted-border bg-subtle px-4 py-3 max-[48rem]:col-auto max-[48rem]:grid-cols-1 [&>span]:grid [&>span]:min-w-0 [&>span]:gap-1 [&_small]:text-xs [&_small]:text-subtle-foreground [&_strong]:[overflow-wrap:anywhere]">
            <span><small>호스트</small><strong>{provider.host}</strong></span>
            <span><small>포트</small><strong>{provider.port}</strong></span>
            <span><small>API</small><strong>{provider.apiBaseUrl}</strong></span>
          </div>
        ));
    }
    return ((
          <>
            <TextField label="정확한 호스트" name="host" required maxLength={253} disabled={disabled} placeholder="git.example.com" />
            <TextField label="포트" name="port" type="number" min="1" max="65535" defaultValue="443" required disabled={disabled} />
            <TextField className="col-span-full min-w-0 max-[48rem]:col-auto" label="API 기본 URL" name="apiBaseUrl" type="url" required maxLength={2048} disabled={disabled} placeholder="https://git.example.com/api" />
          </>
        ));
})()}
      </section>

      {usesOAuth ? (
        <section className="col-span-full grid grid-cols-2 gap-4 border-t border-muted-border pt-5 first:border-t-0 first:pt-0 max-[48rem]:grid-cols-1" aria-labelledby={(function () {
    if (provider) {
        return (`provider-oauth-${provider.id}`);
    }
    return ("provider-oauth-new");
})()}>
          <header className="col-span-full grid gap-1 [&_strong]:text-sm [&_strong]:text-foreground [&_span]:text-xs [&_span]:text-subtle-foreground">
            <strong id={(function () {
    if (provider) {
        return (`provider-oauth-${provider.id}`);
    }
    return ("provider-oauth-new");
})()}>OAuth 애플리케이션</strong>
            <span>{(function () {
    if (isSelfHosted) {
        return ("자체 호스팅 서비스에 등록한 OAuth 애플리케이션 정보를 입력합니다.");
    }
    return ("공식 서비스에 등록한 OAuth 애플리케이션의 클라이언트 ID를 입력합니다.");
})()}</span>
          </header>
          {(function () {
    if (preset) {
        return ((
            <>
              <TextField className="col-span-full min-w-0 max-[48rem]:col-auto" label="OAuth 클라이언트 ID" name="oauthClientId" defaultValue={provider?.oauthClientId ?? ""} required maxLength={1024} disabled={disabled} />
              <input type="hidden" name="oauthAuthorizationUrl" value={preset.oauthAuthorizationUrl} />
              <input type="hidden" name="oauthTokenUrl" value={preset.oauthTokenUrl} />
            </>
          ));
    }
    return ((
            <>
              <TextField label="OAuth 인증 URL" name="oauthAuthorizationUrl" type="url" defaultValue={provider?.oauthAuthorizationUrl ?? ""} required maxLength={2048} disabled={disabled} placeholder="https://git.example.com/oauth/authorize" />
              <TextField label="OAuth 토큰 URL" name="oauthTokenUrl" type="url" defaultValue={provider?.oauthTokenUrl ?? ""} required maxLength={2048} disabled={disabled} placeholder="https://git.example.com/oauth/token" />
              <TextField className="col-span-full min-w-0 max-[48rem]:col-auto" label="OAuth 클라이언트 ID" name="oauthClientId" defaultValue={provider?.oauthClientId ?? ""} required maxLength={1024} disabled={disabled} />
            </>
          ));
})()}
        </section>
      ) : (
        <p className="col-span-full text-xs text-subtle-foreground max-[48rem]:col-auto">일반 HTTPS 제공자는 OAuth를 사용하지 않습니다. 사용자는 프로젝트에서 개인 액세스 토큰을 별도로 연결합니다.</p>
      )}

      <fieldset className="col-span-full m-0 grid grid-cols-2 gap-3 border-0 p-0 max-[40rem]:grid-cols-1">
        <legend className="mb-2 w-full text-sm font-semibold text-foreground">저장소 접근 권한</legend>
        <CheckboxField appearance="card" name="allowsRead" label="읽기 허용" description="저장소 내용과 브랜치 정보를 조회합니다." defaultChecked={provider?.allowsRead ?? true} disabled={disabled} />
        <CheckboxField appearance="card" name="allowsWrite" label="쓰기 허용" description="커밋과 브랜치 변경을 원격 저장소에 반영합니다." defaultChecked={provider?.allowsWrite ?? false} disabled={disabled} />
      </fieldset>
      <AdminFormActions>
        <AdminFormActionNote>{provider ? "정보를 변경하면 연결을 다시 검증해야 합니다." : "비활성 상태로 저장한 뒤 연결과 권한을 검증해 활성화하세요."}</AdminFormActionNote>
        <Button type="submit" variant={provider ? "secondary" : "primary"} disabled={disabled}>{provider ? "제공자 정보 변경" : "제공자 등록"}</Button>
      </AdminFormActions>
    </AdminForm>
  );
}

const OFFICIAL_PROVIDER_PRESETS = {
  github: {
    apiBaseUrl: "https://api.github.com",
    host: "github.com",
    oauthAuthorizationUrl: "https://github.com/login/oauth/authorize",
    oauthTokenUrl: "https://github.com/login/oauth/access_token",
    port: 443
  },
  gitlab: {
    apiBaseUrl: "https://gitlab.com/api/v4",
    host: "gitlab.com",
    oauthAuthorizationUrl: "https://gitlab.com/oauth/authorize",
    oauthTokenUrl: "https://gitlab.com/oauth/token",
    port: 443
  }
} as const;

function providerKindLabel(kind: GitProviderKind): string {
  if (kind === "github") return "GitHub";
  if (kind === "github_enterprise") return "GitHub Enterprise";
  if (kind === "gitlab") return "GitLab";
  if (kind === "gitlab_self_managed") return "자체 호스팅 GitLab";
  return "일반 HTTPS";
}

function input(data: FormData) {
  const nullable = (name: string) => String(data.get(name) ?? "").trim() || null;
  return { displayName: String(data.get("displayName") ?? ""), kind: String(data.get("kind") ?? "generic") as GitProviderKind, host: String(data.get("host") ?? ""), port: Number(data.get("port") ?? 443), apiBaseUrl: String(data.get("apiBaseUrl") ?? ""), oauthAuthorizationUrl: nullable("oauthAuthorizationUrl"), oauthTokenUrl: nullable("oauthTokenUrl"), oauthClientId: nullable("oauthClientId"), allowsRead: data.has("allowsRead"), allowsWrite: data.has("allowsWrite") };
}

function failure(error: unknown) {
  if (error instanceof ApiError && error.status === 412) return { error: true, text: "다른 곳에서 제공자가 변경되었습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { error: true, text: "보안을 위해 다시 로그인한 뒤 Git 제공자 변경을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "이 Git 제공자를 변경할 관리자 권한이 없습니다." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "편집하거나 삭제하기 전에 제공자를 비활성화하세요." };
  return { error: true, text: "Git 제공자 변경을 안전하게 완료하지 못했습니다." };
}
