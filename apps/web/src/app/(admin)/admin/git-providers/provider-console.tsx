"use client";

import { ApiError, activateGitProvider, createGitProvider, deleteGitProvider, disableGitProvider, updateGitProvider } from "@nuriteo/api-client";
import type { GitProviderAdmin, GitProviderKind } from "@nuriteo/api-client";
import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";

import { Badge } from "#src/components/ui/badge.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { CollapsibleContent, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminForm, AdminFormActionNote, AdminFormActions } from "#src/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminCollectionHeading, AdminIntegrationRecord, AdminPage, AdminPanel, AdminRecordActions } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

const PROVIDER_KIND_OPTIONS = [
  { value: "generic", label: "일반 HTTPS" },
  { value: "github", label: "GitHub" },
  { value: "github_enterprise", label: "GitHub Enterprise" },
  { value: "gitlab", label: "GitLab" },
  { value: "gitlab_self_managed", label: "자체 호스팅 GitLab" }
] as const;
import { IntegrationCaConsole } from "#src/app/(admin)/admin/_components/integration-ca-console.tsx";

export function GitProviderConsole({ initialProviders }: { readonly initialProviders: readonly GitProviderAdmin[] }) {
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
      } catch (error) { setFeedback(failure(error)); }
    });
  }

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
      try { await deleteGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, options()); setProviders((items) => items.filter((item) => item.id !== provider.id)); setPendingDeletion(undefined); }
      catch (error) { setFeedback(failure(error)); }
    });
  }

  return <AdminPage id="main-content">
    <AdminPageHeader category="Git 제공자" title="Git 제공자" description="정확한 HTTPS 원본을 등록하세요. 사용자 자격 증명은 분리되어 이 화면에 표시되지 않습니다." aside={<Badge>등록 {providers.length}개</Badge>} />
    <AdminPanel className="admin-create-panel" aria-labelledby="add-git-provider"><CollapsibleRoot defaultOpen={providers.length === 0}><CollapsibleTrigger><span id="add-git-provider">Git 제공자 추가</span><small>비활성 상태로 저장한 뒤 연결을 검증합니다</small></CollapsibleTrigger><CollapsiblePanel><CollapsibleContent><ProviderForm onSubmit={create} disabled={mutation.isPending} /></CollapsibleContent></CollapsiblePanel></CollapsibleRoot></AdminPanel>
    <AdminPanel aria-labelledby="git-provider-list"><AdminCollectionHeading><h2 id="git-provider-list">등록된 제공자</h2><Badge>{providers.length}개</Badge></AdminCollectionHeading>{providers.length === 0 ? <p>등록된 Git 제공자가 없습니다. 위에서 첫 연결을 추가하세요.</p> : <ul className="record-list">{providers.map((provider) => <AdminIntegrationRecord key={provider.id}><div><strong><Link href={`/admin/integrations/git/${provider.id}`}>{provider.displayName}</Link></strong><span>{provider.state === "active" ? "활성" : "비활성"}</span><small>{provider.kind} · {provider.host}:{provider.port} · 설정 v{provider.configVersion}</small></div>{provider.state === "disabled" ? <CollapsibleRoot className="admin-record-disclosure"><CollapsibleTrigger>연결 설정 편집</CollapsibleTrigger><CollapsiblePanel><CollapsibleContent><ProviderForm provider={provider} onSubmit={(event) => void update(event, provider)} disabled={mutation.isPending} /></CollapsibleContent></CollapsiblePanel></CollapsibleRoot> : null}<IntegrationCaConsole type="git_provider" integrationId={provider.id} /><AdminRecordActions>{provider.state === "active" ? <Button onClick={() => void execute(async () => (await disableGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, options())).data, "제공자를 즉시 비활성화했습니다.")} disabled={mutation.isPending}>비활성화</Button> : <Button variant="primary" onClick={() => void execute(async () => (await activateGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, options())).data, "제공자를 검증하고 활성화했습니다.")} disabled={mutation.isPending}>검증 후 활성화</Button>}<Button variant="danger" onClick={() => setPendingDeletion(provider)} disabled={mutation.isPending || provider.state !== "disabled"}>삭제</Button></AdminRecordActions></AdminIntegrationRecord>)}</ul>}</AdminPanel>
    {feedback ? <p role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
    <ConfirmationDialog busy={mutation.isPending} confirmLabel={mutation.isPending ? "삭제 중…" : "제공자 삭제"} description={`${pendingDeletion?.displayName ?? "선택한 제공자"} 설정과 인증서 신뢰 구성이 영구적으로 삭제됩니다.`} open={pendingDeletion !== undefined} title="Git 제공자를 삭제할까요?" onCancel={() => setPendingDeletion(undefined)} onConfirm={() => { if (pendingDeletion) void remove(pendingDeletion); }} />
  </AdminPage>;
}

function ProviderForm({ provider, onSubmit, disabled }: { readonly provider?: GitProviderAdmin; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void; readonly disabled: boolean }) {
  const [kind, setKind] = useState<GitProviderKind>(provider?.kind ?? "generic");
  const preset = OFFICIAL_PROVIDER_PRESETS[kind as keyof typeof OFFICIAL_PROVIDER_PRESETS];
  const isSelfHosted = kind === "github_enterprise" || kind === "gitlab_self_managed";
  const usesOAuth = kind !== "generic";

  return (
    <AdminForm className="admin-provider-form" onSubmit={onSubmit} aria-busy={disabled}>
      <section className="admin-provider-form__section" aria-labelledby={provider ? `provider-basic-${provider.id}` : "provider-basic-new"}>
        <header>
          <strong id={provider ? `provider-basic-${provider.id}` : "provider-basic-new"}>기본 정보</strong>
          <span>관리 화면과 연결 선택기에 표시되는 정보를 설정합니다.</span>
        </header>
        <TextField label="표시 이름" name="displayName" defaultValue={provider?.displayName} required maxLength={200} disabled={disabled} />
        {provider ? (
          <div className="admin-provider-form__readonly">
            <span>제공자 종류</span>
            <strong>{providerKindLabel(kind)}</strong>
          </div>
        ) : (
          <SelectField label="제공자 종류" name="kind" options={PROVIDER_KIND_OPTIONS} value={kind} disabled={disabled} onValueChange={(nextValue) => setKind(nextValue as GitProviderKind)} />
        )}
      </section>

      <section className="admin-provider-form__section" aria-labelledby={provider ? `provider-connection-${provider.id}` : "provider-connection-new"}>
        <header>
          <strong id={provider ? `provider-connection-${provider.id}` : "provider-connection-new"}>연결 정보</strong>
          <span>{preset ? "공식 서비스 주소를 안전한 기본값으로 사용합니다." : "서버가 검증할 정확한 HTTPS 원본을 입력합니다."}</span>
        </header>
        {preset ? (
          <>
            <div className="admin-provider-form__fixed">
              <span><small>호스트</small><strong>{preset.host}</strong></span>
              <span><small>포트</small><strong>{preset.port}</strong></span>
              <span><small>API</small><strong>{preset.apiBaseUrl}</strong></span>
            </div>
            <input type="hidden" name="host" value={preset.host} />
            <input type="hidden" name="port" value={preset.port} />
            <input type="hidden" name="apiBaseUrl" value={preset.apiBaseUrl} />
          </>
        ) : provider ? (
          <div className="admin-provider-form__fixed">
            <span><small>호스트</small><strong>{provider.host}</strong></span>
            <span><small>포트</small><strong>{provider.port}</strong></span>
            <span><small>API</small><strong>{provider.apiBaseUrl}</strong></span>
          </div>
        ) : (
          <>
            <TextField label="정확한 호스트" name="host" required maxLength={253} disabled={disabled} placeholder="git.example.com" />
            <TextField label="포트" name="port" type="number" min="1" max="65535" defaultValue="443" required disabled={disabled} />
            <TextField className="admin-provider-form__wide" label="API 기본 URL" name="apiBaseUrl" type="url" required maxLength={2048} disabled={disabled} placeholder="https://git.example.com/api" />
          </>
        )}
      </section>

      {usesOAuth ? (
        <section className="admin-provider-form__section" aria-labelledby={provider ? `provider-oauth-${provider.id}` : "provider-oauth-new"}>
          <header>
            <strong id={provider ? `provider-oauth-${provider.id}` : "provider-oauth-new"}>OAuth 애플리케이션</strong>
            <span>{isSelfHosted ? "자체 호스팅 서비스에 등록한 OAuth 애플리케이션 정보를 입력합니다." : "공식 서비스에 등록한 OAuth 애플리케이션의 클라이언트 ID를 입력합니다."}</span>
          </header>
          {preset ? (
            <>
              <TextField className="admin-provider-form__wide" label="OAuth 클라이언트 ID" name="oauthClientId" defaultValue={provider?.oauthClientId ?? ""} required maxLength={1024} disabled={disabled} />
              <input type="hidden" name="oauthAuthorizationUrl" value={preset.oauthAuthorizationUrl} />
              <input type="hidden" name="oauthTokenUrl" value={preset.oauthTokenUrl} />
            </>
          ) : (
            <>
              <TextField label="OAuth 인증 URL" name="oauthAuthorizationUrl" type="url" defaultValue={provider?.oauthAuthorizationUrl ?? ""} required maxLength={2048} disabled={disabled} placeholder="https://git.example.com/oauth/authorize" />
              <TextField label="OAuth 토큰 URL" name="oauthTokenUrl" type="url" defaultValue={provider?.oauthTokenUrl ?? ""} required maxLength={2048} disabled={disabled} placeholder="https://git.example.com/oauth/token" />
              <TextField className="admin-provider-form__wide" label="OAuth 클라이언트 ID" name="oauthClientId" defaultValue={provider?.oauthClientId ?? ""} required maxLength={1024} disabled={disabled} />
            </>
          )}
        </section>
      ) : (
        <p className="admin-provider-form__notice">일반 HTTPS 제공자는 OAuth를 사용하지 않습니다. 사용자는 프로젝트에서 개인 액세스 토큰을 별도로 연결합니다.</p>
      )}

      <fieldset className="admin-permissions">
        <legend>저장소 접근 권한</legend>
        <CheckboxField name="allowsRead" label="읽기 허용" description="저장소 내용과 브랜치 정보를 조회합니다." defaultChecked={provider?.allowsRead ?? true} disabled={disabled} />
        <CheckboxField name="allowsWrite" label="쓰기 허용" description="커밋과 브랜치 변경을 원격 저장소에 반영합니다." defaultChecked={provider?.allowsWrite ?? false} disabled={disabled} />
      </fieldset>
      <AdminFormActions>
        <AdminFormActionNote>{provider ? "정보를 변경하면 연결을 다시 검증해야 합니다." : "비활성 상태로 저장한 뒤 연결과 권한을 검증해 활성화하세요."}</AdminFormActionNote>
        <Button type="submit" variant={provider ? "secondary" : "primary"} disabled={disabled}>{provider ? "제공자 정보 변경" : "비활성 제공자 저장"}</Button>
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
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "관리자 권한과 최근 재인증이 필요합니다." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "편집하거나 삭제하기 전에 제공자를 비활성화하세요." };
  return { error: true, text: "Git 제공자 변경을 안전하게 완료하지 못했습니다." };
}
