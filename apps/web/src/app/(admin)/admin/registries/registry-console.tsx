"use client";

import {
  ApiError,
  activateRegistry,
  createRegistry,
  deleteRegistry,
  disableRegistry,
  mapRegistryScope,
  renameRegistry,
  rotateRegistryToken,
  setDefaultRegistry
} from "@nuriteo/api-client";
import type {
  RegistryConfiguration,
  RegistryConnection,
  RegistryScopeRoute
} from "@nuriteo/api-client";
import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";

import { Badge } from "#src/components/ui/badge.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { CollapsibleContent, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminEmptyState, AdminForm, AdminFormActionNote, AdminFormActions, AdminFormFieldSpan, AdminFormSection } from "#src/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { IntegrationCaConsole } from "#src/app/(admin)/admin/_components/integration-ca-console.tsx";
import { AdminCollectionHeading, AdminIntegrationRecord, AdminPage, AdminPanel, AdminRecordActions } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

export function RegistryConsole({
  initialConfiguration
}: {
  readonly initialConfiguration: RegistryConfiguration;
}) {
  const mutation = useExclusiveMutation();
  const [registries, setRegistries] = useState(initialConfiguration.items);
  const [scopes, setScopes] = useState(initialConfiguration.scopes);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const [pendingDeletion, setPendingDeletion] = useState<RegistryConnection>();
  const options = () => ({ csrfToken: readCsrfCredential() });
  const replace = (registry: RegistryConnection) => {
    setRegistries((items) => items.map((item) => {
      if (item.id === registry.id) return registry;
      return registry.isDefault && item.isDefault ? { ...item, isDefault: false } : item;
    }));
  };

  async function run(action: () => Promise<RegistryConnection>, success: string) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        replace(await action());
        setFeedback({ error: false, text: success });
      } catch (error) {
        setFeedback(registryFailure(error));
      }
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await createRegistry(createBrowserApiClient(), {
          displayName: String(data.get("displayName") ?? ""),
          baseUrl: String(data.get("baseUrl") ?? ""),
          token: String(data.get("token") ?? "")
        }, options());
        setRegistries((items) => [...items, result.data]);
        form.reset();
        setFeedback({
          error: false,
          text: "저장소를 비활성 상태로 저장했습니다. 토큰은 다시 표시되지 않으므로 패키지 경로를 연결하기 전에 검증하세요."
        });
      } catch (error) {
        setFeedback(registryFailure(error));
      }
    });
  }

  async function rename(event: FormEvent<HTMLFormElement>, registry: RegistryConnection) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("displayName") ?? "");
    await run(
      async () => (await renameRegistry(createBrowserApiClient(), registry.id, registry.configVersion, name, options())).data,
      "저장소 이름을 변경했습니다."
    );
  }

  async function rotate(event: FormEvent<HTMLFormElement>, registry: RegistryConnection) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = String(new FormData(form).get("token") ?? "");
    await run(
      async () => (await rotateRegistryToken(createBrowserApiClient(), registry.id, registry.configVersion, token, options())).data,
      "토큰을 교체하고 브라우저에서 제거했습니다. 저장소를 다시 검증하세요."
    );
    form.reset();
  }

  async function mapScope(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const scope = String(data.get("scope") ?? "");
    const connectionId = String(data.get("connectionId") ?? "");
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        await mapRegistryScope(createBrowserApiClient(), scope, connectionId, options());
        setScopes((items) => replaceScope(items, { scope, connectionId }));
        setFeedback({ error: false, text: `${scope} 스코프를 선택한 저장소에만 연결했습니다.` });
      } catch (error) {
        setFeedback(registryFailure(error));
      }
    });
  }

  async function remove(registry: RegistryConnection) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        await deleteRegistry(createBrowserApiClient(), registry.id, registry.configVersion, options());
        setRegistries((items) => items.filter((item) => item.id !== registry.id));
        setScopes((items) => items.filter((item) => item.connectionId !== registry.id));
        setPendingDeletion(undefined);
        setFeedback({ error: false, text: "저장소와 보관된 자격 증명을 삭제했습니다." });
      } catch (error) {
        setFeedback(registryFailure(error));
      }
    });
  }

  const active = registries.filter((registry) => registry.state === "active");
  return <AdminPage id="main-content">
    <AdminPageHeader
      category="패키지 저장소"
      title="패키지 저장소"
      description="전역 npm 호환 저장소와 정확한 스코프 경로를 관리합니다. 선택한 경로가 실패해도 다른 저장소로 우회하지 않습니다."
      aside={<Badge>활성 {active.length}개 · 전체 {registries.length}개</Badge>}
    />
    <AdminPanel className="admin-create-panel" aria-labelledby="add-registry"><CollapsibleRoot defaultOpen={registries.length === 0}><CollapsibleTrigger><span id="add-registry">저장소 추가</span><small>연결 검증 전에는 패키지 요청에 사용되지 않습니다</small></CollapsibleTrigger><CollapsiblePanel><CollapsibleContent>
      <AdminForm onSubmit={create} aria-busy={mutation.isPending}>
        <AdminFormSection title="저장소 정보" description="관리 화면에 표시할 이름과 정확한 npm 호환 HTTPS 주소를 입력합니다.">
          <TextField label="표시 이름" name="displayName" maxLength={200} required disabled={mutation.isPending} />
          <TextField label="HTTPS 기본 URL" description="npm 호환 레지스트리의 기본 주소" name="baseUrl" type="url" maxLength={2048} required disabled={mutation.isPending} placeholder="https://registry.example.com" />
        </AdminFormSection>
        <AdminFormSection title="인증 정보" description="패키지 읽기와 게시에 사용할 전용 접근 토큰을 등록합니다.">
          <AdminFormFieldSpan><TextField label="접근 토큰" description="토큰은 저장 후 다시 표시되지 않습니다." name="token" type="password" autoComplete="new-password" maxLength={4096} required disabled={mutation.isPending} /></AdminFormFieldSpan>
        </AdminFormSection>
        <AdminFormActions>
          <AdminFormActionNote>비활성 상태로 저장한 뒤 연결 검증을 통과해야 패키지 요청에 사용할 수 있습니다.</AdminFormActionNote>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>비활성 저장소 저장</Button>
        </AdminFormActions>
      </AdminForm></CollapsibleContent></CollapsiblePanel></CollapsibleRoot>
    </AdminPanel>
    <AdminPanel aria-labelledby="registry-list">
      <AdminCollectionHeading><h2 id="registry-list">등록된 저장소</h2><Badge>{registries.length}개</Badge></AdminCollectionHeading>
      {registries.length === 0 ? <AdminEmptyState title="등록된 패키지 저장소가 없습니다">위의 추가 영역에서 첫 npm 호환 저장소를 등록하세요.</AdminEmptyState> : <ul className="record-list">{registries.map((registry) => <AdminIntegrationRecord key={registry.id}>
        <div><strong><Link href={`/admin/integrations/registries/${registry.id}`}>{registry.displayName}</Link>{registry.isDefault ? " · 기본값" : ""}</strong><span>{registry.state === "active" ? "활성" : "비활성"}</span><small>{registry.baseUrl} · 설정 v{registry.configVersion} · 자격 증명 v{registry.credentialVersion}</small></div>
        {registry.state === "disabled" ? <CollapsibleRoot className="admin-record-disclosure"><CollapsibleTrigger>저장소 설정 및 토큰</CollapsibleTrigger><CollapsiblePanel><CollapsibleContent>
          <form className="collaboration-form" onSubmit={(event) => void rename(event, registry)}><TextField label="표시 이름" name="displayName" defaultValue={registry.displayName} maxLength={200} required disabled={mutation.isPending} /><Button disabled={mutation.isPending}>이름 변경</Button></form>
          <form className="collaboration-form" onSubmit={(event) => void rotate(event, registry)}><TextField label="교체 토큰" name="token" type="password" autoComplete="new-password" maxLength={4096} required disabled={mutation.isPending} /><Button disabled={mutation.isPending}>토큰 교체</Button></form>
        </CollapsibleContent></CollapsiblePanel></CollapsibleRoot> : null}
        <IntegrationCaConsole type="registry" integrationId={registry.id} />
        <AdminRecordActions>
          {registry.state === "active" ? <Button disabled={mutation.isPending} onClick={() => void run(async () => (await disableRegistry(createBrowserApiClient(), registry.id, registry.configVersion, options())).data, "저장소를 즉시 비활성화했습니다. 연결된 경로는 다른 저장소로 우회하지 않습니다.")}>비활성화</Button> : <Button variant="primary" disabled={mutation.isPending} onClick={() => void run(async () => (await activateRegistry(createBrowserApiClient(), registry.id, registry.configVersion, options())).data, "저장소를 검증하고 활성화했습니다.")}>검증 후 활성화</Button>}
          <Button disabled={mutation.isPending || registry.state !== "active" || registry.isDefault} onClick={() => void run(async () => (await setDefaultRegistry(createBrowserApiClient(), registry.id, registry.configVersion, options())).data, "기본 저장소를 변경했습니다.")}>기본값으로 설정</Button>
          <Button variant="danger" disabled={mutation.isPending || registry.state !== "disabled"} onClick={() => setPendingDeletion(registry)}>삭제</Button>
        </AdminRecordActions>
      </AdminIntegrationRecord>)}</ul>}
    </AdminPanel>
    <AdminPanel aria-labelledby="scope-routing">
      <h2 id="scope-routing">스코프 경로</h2>
      <p><code>@company</code> 같은 정확한 npm 스코프를 하나의 활성 저장소에 연결합니다. 저장소를 사용할 수 없으면 안전하게 실패합니다.</p>
      <AdminForm onSubmit={mapScope}>
        <AdminFormSection title="경로 추가" description="하나의 스코프는 하나의 활성 저장소에만 연결됩니다.">
          <TextField label="패키지 스코프" name="scope" placeholder="@company" maxLength={65} required disabled={mutation.isPending || active.length === 0} />
          <SelectField label="저장소" name="connectionId" options={active.map((registry) => ({ value: registry.id, label: registry.displayName }))} required disabled={mutation.isPending || active.length === 0} />
        </AdminFormSection>
        <AdminFormActions>
          <AdminFormActionNote>{active.length === 0 ? "먼저 저장소 연결을 검증하고 활성화하세요." : "저장소 장애 시 다른 경로로 자동 우회하지 않습니다."}</AdminFormActionNote>
          <Button disabled={mutation.isPending || active.length === 0}>스코프 경로 저장</Button>
        </AdminFormActions>
      </AdminForm>
      {scopes.length === 0 ? <AdminEmptyState title="등록된 스코프 경로가 없습니다">활성 저장소를 선택해 첫 패키지 경로를 추가하세요.</AdminEmptyState> : <ul className="record-list">{scopes.map((route) => <li key={route.scope}><div><strong>{route.scope}</strong><span>{registries.find((registry) => registry.id === route.connectionId)?.displayName ?? "사용할 수 없는 저장소"}</span></div></li>)}</ul>}
    </AdminPanel>
    {feedback ? <p className={`notification-feedback notification-feedback--${feedback.error ? "error" : "success"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
    <ConfirmationDialog busy={mutation.isPending} confirmLabel={mutation.isPending ? "삭제 중…" : "저장소 삭제"} description={`${pendingDeletion?.displayName ?? "선택한 저장소"}의 자격 증명과 연결된 스코프 경로가 영구적으로 삭제됩니다.`} open={pendingDeletion !== undefined} title="패키지 저장소를 삭제할까요?" onCancel={() => setPendingDeletion(undefined)} onConfirm={() => { if (pendingDeletion) void remove(pendingDeletion); }} />
  </AdminPage>;
}

function replaceScope(
  routes: readonly RegistryScopeRoute[],
  replacement: RegistryScopeRoute
): readonly RegistryScopeRoute[] {
  const remaining = routes.filter((route) => route.scope !== replacement.scope);
  return [...remaining, replacement].toSorted((left, right) => left.scope.localeCompare(right.scope));
}

function registryFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "변경이 완료되었을 수 있습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 412) return { error: true, text: "다른 곳에서 저장소가 변경되었습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "관리자 권한과 최근 재인증이 필요합니다." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: "검증에 실패했습니다. HTTPS URL, 토큰, TLS 신뢰와 저장소 네트워크 연결을 확인하세요." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "편집하거나 삭제하기 전에 저장소를 비활성화하세요. 활성 스코프 경로는 다른 저장소로 우회하지 않습니다." };
  return { error: true, text: "저장소 변경을 안전하게 완료하지 못했습니다." };
}
