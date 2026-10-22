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
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { TextField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminEmptyState, AdminForm, AdminFormActionNote, AdminFormActions, AdminFormSection } from "#src/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { IntegrationCaConsole } from "#src/app/(admin)/admin/_components/integration-ca-console.tsx";

export function OidcProviderConsole({ initialProviders }: { readonly initialProviders: readonly OidcProvider[] }) {
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
      } catch (error) { setFeedback(providerFailure(error)); }
    });
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
      try { await deleteOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, options()); setProviders((items) => items.filter((item) => item.id !== provider.id)); setPendingDeletion(undefined); setFeedback({ error: false, text: "제공자를 삭제했습니다." }); }
      catch (error) { setFeedback(providerFailure(error)); }
    });
  }

  return <main id="main-content" className="workspace-page admin-detail-page">
    <AdminPageHeader category="인증 제공자" title="로그인 제공자" description="전역 OIDC 제공자를 관리합니다. 새 설정은 검색, TLS, 발급자, 엔드포인트와 자격 증명 검증을 통과하기 전까지 비활성 상태로 유지됩니다." aside={<span className="admin-page-header__count">등록 {providers.length}개</span>} />
    <section className="admin-detail-panel admin-create-panel" aria-labelledby="add-provider"><details open={providers.length === 0}><summary><span id="add-provider">OIDC 제공자 추가</span><small>검증 전에는 로그인 화면에 노출되지 않습니다</small></summary><AdminForm onSubmit={create} aria-busy={mutation.isPending}>
      <AdminFormSection title="연결 정보" description="사용자가 인식할 이름과 OIDC Discovery 발급자 주소를 입력합니다.">
        <TextField label="표시 이름" name="displayName" maxLength={200} required disabled={mutation.isPending} />
        <TextField label="발급자 URL" description="OIDC Discovery를 제공하는 HTTPS 주소" name="issuer" type="url" maxLength={2048} required disabled={mutation.isPending} placeholder="https://id.example.com" />
      </AdminFormSection>
      <AdminFormSection title="클라이언트 자격 증명" description="인증 제공자에서 발급한 웹 애플리케이션 자격 증명을 등록합니다.">
        <TextField label="클라이언트 ID" name="clientId" maxLength={1024} required disabled={mutation.isPending} />
        <TextField label="클라이언트 비밀키" description="저장 후 다시 표시되지 않습니다." name="clientSecret" type="password" autoComplete="new-password" maxLength={4096} required disabled={mutation.isPending} />
      </AdminFormSection>
      <AdminFormActions>
        <AdminFormActionNote>먼저 비활성 상태로 저장합니다. Discovery, TLS와 리디렉션 URI 검증을 통과한 뒤 별도로 활성화하세요.</AdminFormActionNote>
        <Button type="submit" variant="primary" disabled={mutation.isPending}>비활성 제공자 저장</Button>
      </AdminFormActions>
    </AdminForm></details></section>
    <section className="admin-detail-panel" aria-labelledby="provider-list"><div className="admin-collection-heading"><h2 id="provider-list">등록된 제공자</h2><span className="admin-page-header__count">{providers.length}개</span></div>{providers.length === 0 ? <AdminEmptyState title="등록된 로그인 제공자가 없습니다">위의 추가 영역에서 첫 OIDC 연결을 등록하세요.</AdminEmptyState> : <ul className="record-list">{providers.map((provider) => <li className="admin-integration-record" key={provider.id}><div><strong>{provider.displayName}</strong><span>{provider.state} · 연결된 계정 {provider.linkedIdentityCount}개</span><small>{provider.issuer} · 설정 v{provider.configVersion} · 비밀키 v{provider.secretVersion}</small></div>
      <details className="admin-record-disclosure"><summary>연결 설정 및 비밀키</summary><form className="collaboration-form" onSubmit={(event) => void update(event, provider)}><TextField label="표시 이름" name="displayName" defaultValue={provider.displayName} required disabled={mutation.isPending || provider.state === "active"} /><TextField label="클라이언트 ID" name="clientId" defaultValue={provider.clientId} required disabled={mutation.isPending || provider.state === "active"} /><Button disabled={mutation.isPending || provider.state === "active"}>정보 변경</Button></form>
      {provider.state === "disabled" ? <form className="collaboration-form" onSubmit={(event) => void rotate(event, provider)}><TextField label="교체할 클라이언트 비밀키" name="clientSecret" type="password" autoComplete="new-password" maxLength={4096} required disabled={mutation.isPending} /><Button disabled={mutation.isPending}>비밀키 교체</Button></form> : null}</details>
      <IntegrationCaConsole type="oidc" integrationId={provider.id} />
      <div className="record-actions">{provider.state === "active" ? <Button disabled={mutation.isPending} onClick={() => void run(async () => (await disableOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, options())).data, "제공자를 즉시 비활성화했습니다.")}>비활성화</Button> : <Button variant="primary" disabled={mutation.isPending} onClick={() => void run(async () => (await activateOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, `${window.location.origin}/api/v1/auth/oidc/${provider.id}/callback`, options())).data, "제공자를 검증하고 활성화했습니다.")}>검증 후 활성화</Button>}
      <Button variant="danger" disabled={mutation.isPending || provider.state !== "disabled" || provider.linkedIdentityCount !== 0} onClick={() => setPendingDeletion(provider)}>삭제</Button></div></li>)}</ul>}</section>
    {feedback ? <p className={`notification-feedback notification-feedback--${feedback.error ? "error" : "success"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
    <ConfirmationDialog busy={mutation.isPending} confirmLabel={mutation.isPending ? "삭제 중…" : "제공자 삭제"} description={`${pendingDeletion?.displayName ?? "선택한 제공자"} 설정과 저장된 비밀키가 영구적으로 삭제됩니다.`} open={pendingDeletion !== undefined} title="인증 제공자를 삭제할까요?" onCancel={() => setPendingDeletion(undefined)} onConfirm={() => { if (pendingDeletion) void remove(pendingDeletion); }} />
  </main>;
}

function providerFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "변경이 완료되었을 수 있습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 412) return { error: true, text: "다른 곳에서 제공자가 변경되었습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "관리자 권한과 최근 재인증이 필요합니다." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: "검증에 실패했습니다. HTTPS 발급자, 클라이언트 설정, 리디렉션 URI와 제공자 네트워크 연결을 확인하세요." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "먼저 제공자를 비활성화하고 연결된 계정을 제거한 뒤 삭제하세요." };
  return { error: true, text: "제공자 변경을 안전하게 완료하지 못했습니다." };
}
