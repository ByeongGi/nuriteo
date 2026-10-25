"use client";

import {
  ApiError,
  activateOidcProvider,
  createOidcProvider,
  deleteOidcProvider,
  disableOidcProvider,
  rotateOidcProviderSecret,
  updateOidcProvider
} from "@nuriteo/api-client";
import type { OidcProvider } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Badge } from "#src/components/ui/badge.tsx";
import { buttonVariants } from "#src/components/ui/button.styles.ts";
import { Button } from "#src/components/ui/button.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { TextField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminEmptyState, AdminForm, AdminFormActionNote, AdminFormActions, AdminFormSection } from "#src/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminConnectionGuide } from "#src/app/(admin)/admin/_components/admin-connection-guide.tsx";
import { AdminIntegrationActionBar, AdminIntegrationBackLink, AdminIntegrationDangerSection, AdminIntegrationReadOnlyGrid, AdminIntegrationSection, AdminIntegrationSummary } from "#src/app/(admin)/admin/_components/admin-integration-detail.tsx";
import { IntegrationCaConsole } from "#src/app/(admin)/admin/_components/integration-ca-console.tsx";
import { AdminCollectionHeading, AdminFeedback, AdminIntegrationRecord, AdminPage, AdminPanel, AdminRecordActions, AdminSection } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

export function OidcProviderConsole({ createMode = false, detailMode = false, initialProviders }: { readonly createMode?: boolean; readonly detailMode?: boolean; readonly initialProviders: readonly OidcProvider[] }) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [providers, setProviders] = useState(initialProviders);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const [pendingDeletion, setPendingDeletion] = useState<OidcProvider>();
  const options = () => ({ csrfToken: readCsrfCredential() });
  const replace = (provider: OidcProvider) => setProviders((items) => items.map((item) => item.id === provider.id ? provider : item));

  async function run(action: () => Promise<OidcProvider>, success: string) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try { replace(await action()); setFeedback({ error: false, text: success }); }
      catch (error) { setFeedback(providerFailure(error)); }
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await createOidcProvider(createBrowserApiClient(), {
          displayName: String(data.get("displayName") ?? ""), issuer: String(data.get("issuer") ?? ""),
          clientId: String(data.get("clientId") ?? ""), clientSecret: String(data.get("clientSecret") ?? "")
        }, options());
        setProviders((items) => [...items, result.data]); form.reset();
        setFeedback({ error: false, text: "제공자를 비활성 상태로 저장했습니다. 사용자가 로그인하기 전에 검증하고 활성화하세요." });
        if (createMode) router.replace(`/admin/authentication/oidc/${result.data.id}`);
      } catch (error) { setFeedback(providerFailure(error)); }
    });
  }

  if (createMode) {
    return <OidcProviderCreate busy={mutation.isPending} feedback={feedback} onSubmit={create} />;
  }

  async function update(event: FormEvent<HTMLFormElement>, provider: OidcProvider) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    await run(async () => (await updateOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, { displayName: String(data.get("displayName") ?? ""), clientId: String(data.get("clientId") ?? "") }, options())).data, "제공자 정보를 변경했습니다. 검증을 통과할 때까지 비활성 상태로 유지됩니다.");
  }

  async function rotate(event: FormEvent<HTMLFormElement>, provider: OidcProvider) {
    event.preventDefault();
    const form = event.currentTarget;
    const secret = String(new FormData(form).get("clientSecret") ?? "");
    await run(async () => (await rotateOidcProviderSecret(createBrowserApiClient(), provider.id, provider.configVersion, secret, options())).data, "클라이언트 비밀키를 교체했습니다. 제공자를 다시 검증하고 활성화하세요.");
    form.reset();
  }

  async function remove(provider: OidcProvider) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try { await deleteOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, options()); setProviders((items) => items.filter((item) => item.id !== provider.id)); setPendingDeletion(undefined); setFeedback({ error: false, text: "제공자를 삭제했습니다." }); if (detailMode) router.replace("/admin/authentication/oidc"); }
      catch (error) { setFeedback(providerFailure(error)); }
    });
  }

  const detailProvider = detailMode ? providers[0] : undefined;
  if (detailProvider) {
    return <OidcProviderDetail
      provider={detailProvider}
      busy={mutation.isPending}
      feedback={feedback}
      pendingDeletion={pendingDeletion}
      onActivate={() => void run(async () => (await activateOidcProvider(createBrowserApiClient(), detailProvider.id, detailProvider.configVersion, `${window.location.origin}/api/v1/auth/oidc/${detailProvider.id}/callback`, options())).data, "제공자를 검증하고 활성화했습니다.")}
      onDelete={() => setPendingDeletion(detailProvider)}
      onDeleteCancel={() => setPendingDeletion(undefined)}
      onDeleteConfirm={() => void remove(detailProvider)}
      onDisable={() => void run(async () => (await disableOidcProvider(createBrowserApiClient(), detailProvider.id, detailProvider.configVersion, options())).data, "제공자를 즉시 비활성화했습니다.")}
      onRotate={(event) => void rotate(event, detailProvider)}
      onUpdate={(event) => void update(event, detailProvider)}
    />;
  }

  return <AdminPage id="main-content" contentWidth="standard">
    <AdminPageHeader category="접근 관리" title="로그인 제공자" description="전역 OIDC 제공자의 상태와 사용자 연결을 확인합니다." aside={<div className="flex items-center gap-2"><Badge>등록 {providers.length}개</Badge><Link className={buttonVariants({ size: "sm", variant: "primary" })} href="/admin/authentication/oidc/new">새 제공자</Link></div>} />
    <AdminPanel aria-labelledby="provider-list"><AdminCollectionHeading><h2 id="provider-list">등록된 제공자</h2><Badge>{providers.length}개</Badge></AdminCollectionHeading>{providers.length === 0 ? <AdminEmptyState title="등록된 로그인 제공자가 없습니다">새 제공자를 등록해 첫 OIDC 연결을 구성하세요.</AdminEmptyState> : <ul className="mt-6 grid list-none gap-2 p-0">{providers.map((provider) => <AdminIntegrationRecord key={provider.id}><div><strong>{provider.displayName}</strong><span>{provider.state === "active" ? "활성" : "비활성"} · 연결된 계정 {provider.linkedIdentityCount}개</span><small>{provider.issuer} · 설정 v{provider.configVersion}</small></div><AdminRecordActions><Link className={buttonVariants({ size: "sm", variant: "secondary" })} href={`/admin/authentication/oidc/${provider.id}`}>상세 보기</Link></AdminRecordActions></AdminIntegrationRecord>)}</ul>}</AdminPanel>
    {feedback ? <AdminFeedback feedbackTone={feedback.error ? "danger" : "success"} role={feedback.error ? "alert" : "status"}>{feedback.text}</AdminFeedback> : null}
    <ConfirmationDialog busy={mutation.isPending} confirmLabel={mutation.isPending ? "삭제 중…" : "제공자 삭제"} description={`${pendingDeletion?.displayName ?? "선택한 제공자"} 설정과 저장된 비밀키가 영구적으로 삭제됩니다.`} open={pendingDeletion !== undefined} title="인증 제공자를 삭제할까요?" onCancel={() => setPendingDeletion(undefined)} onConfirm={() => { if (pendingDeletion) void remove(pendingDeletion); }} />
  </AdminPage>;
}

interface OidcProviderDetailProps {
  readonly busy: boolean;
  readonly feedback: { readonly error: boolean; readonly text: string } | undefined;
  readonly onActivate: () => void;
  readonly onDelete: () => void;
  readonly onDeleteCancel: () => void;
  readonly onDeleteConfirm: () => void;
  readonly onDisable: () => void;
  readonly onRotate: (event: FormEvent<HTMLFormElement>) => void;
  readonly onUpdate: (event: FormEvent<HTMLFormElement>) => void;
  readonly pendingDeletion: OidcProvider | undefined;
  readonly provider: OidcProvider;
}

function OidcProviderCreate({ busy, feedback, onSubmit }: { readonly busy: boolean; readonly feedback: { readonly error: boolean; readonly text: string } | undefined; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <AdminPage id="main-content" contentWidth="narrow" aria-busy={busy}>
      <AdminIntegrationBackLink href="/admin/authentication/oidc">로그인 제공자</AdminIntegrationBackLink>
      <AdminPageHeader category="로그인 제공자" title="새 OIDC 제공자" description="연결 정보를 저장한 뒤 상세 화면에서 검증하고 활성화합니다." />
      <AdminConnectionGuide subject="로그인 제공자" />
      <AdminPanel>
        <AdminForm onSubmit={onSubmit} aria-busy={busy}>
          <AdminFormSection title="연결 정보" description="사용자가 인식할 이름과 OIDC Discovery 발급자 주소를 입력합니다.">
            <TextField label="표시 이름" name="displayName" maxLength={200} required disabled={busy} />
            <TextField label="발급자 URL" description="OIDC Discovery를 제공하는 HTTPS 주소" name="issuer" type="url" maxLength={2048} required disabled={busy} placeholder="https://id.example.com" />
          </AdminFormSection>
          <AdminFormSection title="클라이언트 자격 증명" description="인증 제공자에서 발급한 웹 애플리케이션 자격 증명을 등록합니다.">
            <TextField label="클라이언트 ID" name="clientId" maxLength={1024} required disabled={busy} />
            <TextField label="클라이언트 비밀키" description="저장 후 다시 표시되지 않습니다." name="clientSecret" type="password" autoComplete="new-password" maxLength={4096} required disabled={busy} />
          </AdminFormSection>
          <AdminFormActions><AdminFormActionNote>비활성 상태로 저장되며 완료 후 상세 화면으로 이동합니다.</AdminFormActionNote><Button type="submit" variant="primary" disabled={busy}>제공자 등록</Button></AdminFormActions>
        </AdminForm>
      </AdminPanel>
      {feedback ? <AdminFeedback feedbackTone={feedback.error ? "danger" : "success"} role={feedback.error ? "alert" : "status"}>{feedback.text}</AdminFeedback> : null}
    </AdminPage>
  );
}

function OidcProviderDetail({ busy, feedback, onActivate, onDelete, onDeleteCancel, onDeleteConfirm, onDisable, onRotate, onUpdate, pendingDeletion, provider }: OidcProviderDetailProps) {
  const active = provider.state === "active";
  return (
    <AdminPage id="main-content" contentWidth="standard" aria-busy={busy}>
      <AdminIntegrationBackLink href="/admin/authentication/oidc">로그인 제공자</AdminIntegrationBackLink>
      <AdminPageHeader
        category="로그인 제공자"
        title={provider.displayName}
        description="로그인 연결 상태와 사용자 영향을 확인하고, 검증이 필요한 변경을 안전하게 적용하세요."
        aside={<Badge tone={active ? "success" : "neutral"} variant="status">{active ? "활성" : "비활성"}</Badge>}
      />
      <AdminIntegrationSummary
        state={active ? "active" : "disabled"}
        title={active ? "사용자가 이 제공자로 로그인할 수 있습니다" : "현재 로그인 화면에 노출되지 않습니다"}
        description={active ? "설정을 변경하려면 먼저 연결을 비활성화하세요. 기존 연결 계정은 삭제되지 않습니다." : "연결 정보와 비밀키를 확인한 뒤 실제 OIDC 검증을 통과하면 활성화할 수 있습니다."}
        metrics={[
          { label: "연결된 계정", value: `${provider.linkedIdentityCount}개` },
          { label: "설정 버전", value: `v${provider.configVersion}` },
          { label: "비밀키 버전", value: `v${provider.secretVersion}` },
          { label: "최근 변경", value: formatProviderDate(provider.updatedAt) }
        ]}
      />
      <AdminIntegrationSection title="연결 정보" description="OIDC Discovery 발급자와 웹 애플리케이션 식별자를 관리합니다.">
        {active ? (
          <AdminIntegrationReadOnlyGrid items={[
            { label: "표시 이름", value: provider.displayName },
            { label: "클라이언트 ID", value: provider.clientId },
            { label: "발급자 URL", value: provider.issuer },
            { label: "콜백 URL", value: `${window.location.origin}/api/v1/auth/oidc/${provider.id}/callback` }
          ]} />
        ) : (
          <form className="grid grid-cols-2 items-end gap-4 max-[42rem]:grid-cols-1" onSubmit={onUpdate}>
            <TextField label="표시 이름" name="displayName" defaultValue={provider.displayName} required disabled={busy} />
            <TextField label="클라이언트 ID" name="clientId" defaultValue={provider.clientId} required disabled={busy} />
            <Button className="col-span-full justify-self-end max-[42rem]:w-full" disabled={busy}>연결 정보 저장</Button>
          </form>
        )}
      </AdminIntegrationSection>
      <AdminIntegrationSection title="클라이언트 비밀키" description="비밀키는 저장 후 다시 표시되지 않으며 교체 시 재검증이 필요합니다.">
        {active ? <p className="m-0 text-sm text-muted-foreground">활성 연결의 비밀키는 보호되어 있습니다. 비밀키를 교체하려면 먼저 연결을 비활성화하세요.</p> : (
          <form className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 max-[42rem]:grid-cols-1" onSubmit={onRotate}>
            <TextField label="새 클라이언트 비밀키" name="clientSecret" type="password" autoComplete="new-password" maxLength={4096} required disabled={busy} />
            <Button disabled={busy}>비밀키 교체</Button>
          </form>
        )}
      </AdminIntegrationSection>
      <AdminIntegrationSection title="TLS 인증서 신뢰" description="사설 인증 기관을 사용하는 제공자에만 별도 CA를 등록하세요.">
        <IntegrationCaConsole appearance="detail" type="oidc" integrationId={provider.id} />
      </AdminIntegrationSection>
      <AdminSection>
        <AdminIntegrationActionBar note={active ? "비활성화하면 신규 OIDC 로그인이 즉시 중단됩니다. 연결된 계정 정보는 유지됩니다." : "활성화 전에 Discovery, TLS, 자격 증명과 콜백 URL을 실제로 검증합니다."}>
          {active ? <Button disabled={busy} onClick={onDisable}>로그인 연결 비활성화</Button> : <Button variant="primary" disabled={busy} onClick={onActivate}>검증 후 활성화</Button>}
        </AdminIntegrationActionBar>
      </AdminSection>
      <AdminIntegrationDangerSection title="제공자 삭제" description="설정과 저장된 비밀키를 영구적으로 제거합니다. 연결된 계정이 있거나 활성 상태이면 삭제할 수 없습니다.">
        <Button variant="danger" disabled={busy || active || provider.linkedIdentityCount !== 0} onClick={onDelete}>제공자 삭제</Button>
      </AdminIntegrationDangerSection>
      {feedback ? <AdminFeedback feedbackTone={feedback.error ? "danger" : "success"} role={feedback.error ? "alert" : "status"}>{feedback.text}</AdminFeedback> : null}
      <ConfirmationDialog busy={busy} confirmLabel={busy ? "삭제 중…" : "제공자 삭제"} description={`${provider.displayName} 설정과 저장된 비밀키가 영구적으로 삭제됩니다.`} open={pendingDeletion !== undefined} title="인증 제공자를 삭제할까요?" onCancel={onDeleteCancel} onConfirm={onDeleteConfirm} />
    </AdminPage>
  );
}

function formatProviderDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function providerFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "변경이 완료되었을 수 있습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 412) return { error: true, text: "다른 곳에서 제공자가 변경되었습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { error: true, text: "보안을 위해 다시 로그인한 뒤 제공자 변경을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "이 제공자를 변경할 관리자 권한이 없습니다." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: "검증에 실패했습니다. HTTPS 발급자, 클라이언트 설정, 리디렉션 URI와 제공자 네트워크 연결을 확인하세요." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "먼저 제공자를 비활성화하고 연결된 계정을 제거한 뒤 삭제하세요." };
  return { error: true, text: "제공자 변경을 안전하게 완료하지 못했습니다." };
}
