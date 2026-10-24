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
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Badge } from "#src/components/ui/badge.tsx";
import { buttonVariants } from "#src/components/ui/button.styles.ts";
import { Button } from "#src/components/ui/button.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminEmptyState, AdminForm, AdminFormActionNote, AdminFormActions, AdminFormFieldSpan, AdminFormSection } from "#src/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminConnectionGuide } from "#src/app/(admin)/admin/_components/admin-connection-guide.tsx";
import { AdminIntegrationActionBar, AdminIntegrationBackLink, AdminIntegrationDangerSection, AdminIntegrationReadOnlyGrid, AdminIntegrationSection, AdminIntegrationSummary } from "#src/app/(admin)/admin/_components/admin-integration-detail.tsx";
import { IntegrationCaConsole } from "#src/app/(admin)/admin/_components/integration-ca-console.tsx";
import { AdminCollectionHeading, AdminFeedback, AdminIntegrationRecord, AdminPage, AdminPanel, AdminRecordActions, AdminSection } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

export function RegistryConsole({
  createMode = false,
  detailMode = false,
  initialConfiguration
}: {
  readonly createMode?: boolean;
  readonly detailMode?: boolean;
  readonly initialConfiguration: RegistryConfiguration;
}) {
  const router = useRouter();
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
        if (createMode) router.replace(`/admin/integrations/registries/${result.data.id}`);
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
        if (detailMode) router.replace("/admin/integrations/registries");
      } catch (error) {
        setFeedback(registryFailure(error));
      }
    });
  }

  const active = registries.filter((registry) => registry.state === "active");
  if (createMode) return <RegistryCreate busy={mutation.isPending} feedback={feedback} onSubmit={create} />;
  const detailRegistry = detailMode ? registries[0] : undefined;
  if (detailRegistry) {
    return <RegistryDetail
      registry={detailRegistry}
      scopes={scopes}
      busy={mutation.isPending}
      feedback={feedback}
      pendingDeletion={pendingDeletion}
      onActivate={() => void run(async () => (await activateRegistry(createBrowserApiClient(), detailRegistry.id, detailRegistry.configVersion, options())).data, "저장소를 검증하고 활성화했습니다.")}
      onDelete={() => setPendingDeletion(detailRegistry)}
      onDeleteCancel={() => setPendingDeletion(undefined)}
      onDeleteConfirm={() => void remove(detailRegistry)}
      onDisable={() => void run(async () => (await disableRegistry(createBrowserApiClient(), detailRegistry.id, detailRegistry.configVersion, options())).data, "저장소를 즉시 비활성화했습니다. 연결된 경로는 다른 저장소로 우회하지 않습니다.")}
      onRename={(event) => void rename(event, detailRegistry)}
      onRotate={(event) => void rotate(event, detailRegistry)}
      onSetDefault={() => void run(async () => (await setDefaultRegistry(createBrowserApiClient(), detailRegistry.id, detailRegistry.configVersion, options())).data, "기본 저장소를 변경했습니다.")}
    />;
  }

  return <AdminPage id="main-content" contentWidth="standard">
    <AdminPageHeader
      category="연동"
      title="패키지 저장소"
      description="전역 npm 호환 저장소와 정확한 스코프 경로를 관리합니다. 선택한 경로가 실패해도 다른 저장소로 우회하지 않습니다."
      aside={<div className="flex items-center gap-2"><Badge>활성 {active.length}개 · 전체 {registries.length}개</Badge><Link className={buttonVariants({ size: "sm", variant: "primary" })} href="/admin/integrations/registries/new">새 저장소</Link></div>}
    />
    <AdminPanel aria-labelledby="registry-list">
      <AdminCollectionHeading><h2 id="registry-list">등록된 저장소</h2><Badge>{registries.length}개</Badge></AdminCollectionHeading>
      {registries.length === 0 ? <AdminEmptyState title="등록된 패키지 저장소가 없습니다">새 저장소를 등록해 첫 npm 호환 연결을 구성하세요.</AdminEmptyState> : <ul className="mt-6 grid list-none gap-2 p-0">{registries.map((registry) => <AdminIntegrationRecord key={registry.id}>
        <div><strong>{registry.displayName}{registry.isDefault ? " · 기본값" : ""}</strong><span>{registry.state === "active" ? "활성" : "비활성"}</span><small>{registry.baseUrl} · 연결된 스코프 {scopes.filter((scope) => scope.connectionId === registry.id).length}개</small></div>
        <AdminRecordActions><Link className={buttonVariants({ size: "sm", variant: "secondary" })} href={`/admin/integrations/registries/${registry.id}`}>상세 보기</Link></AdminRecordActions>
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
      {scopes.length === 0 ? <AdminEmptyState title="등록된 스코프 경로가 없습니다">활성 저장소를 선택해 첫 패키지 경로를 추가하세요.</AdminEmptyState> : <ul className="mt-6 grid list-none gap-2 p-0 [&>li]:flex [&>li]:items-center [&>li]:justify-between [&>li]:gap-3 [&>li]:border-b [&>li]:border-muted-border [&>li]:py-3 [&>li>div]:grid [&>li>div]:gap-1 [&_span]:text-xs [&_span]:text-muted-foreground">{scopes.map((route) => <li key={route.scope}><div><strong>{route.scope}</strong><span>{registries.find((registry) => registry.id === route.connectionId)?.displayName ?? "사용할 수 없는 저장소"}</span></div></li>)}</ul>}
    </AdminPanel>
    {feedback ? <AdminFeedback feedbackTone={feedback.error ? "danger" : "success"} role={feedback.error ? "alert" : "status"}>{feedback.text}</AdminFeedback> : null}
    <ConfirmationDialog busy={mutation.isPending} confirmLabel={mutation.isPending ? "삭제 중…" : "저장소 삭제"} description={`${pendingDeletion?.displayName ?? "선택한 저장소"}의 자격 증명과 연결된 스코프 경로가 영구적으로 삭제됩니다.`} open={pendingDeletion !== undefined} title="패키지 저장소를 삭제할까요?" onCancel={() => setPendingDeletion(undefined)} onConfirm={() => { if (pendingDeletion) void remove(pendingDeletion); }} />
  </AdminPage>;
}

interface RegistryDetailProps {
  readonly busy: boolean;
  readonly feedback: { readonly error: boolean; readonly text: string } | undefined;
  readonly onActivate: () => void;
  readonly onDelete: () => void;
  readonly onDeleteCancel: () => void;
  readonly onDeleteConfirm: () => void;
  readonly onDisable: () => void;
  readonly onRename: (event: FormEvent<HTMLFormElement>) => void;
  readonly onRotate: (event: FormEvent<HTMLFormElement>) => void;
  readonly onSetDefault: () => void;
  readonly pendingDeletion: RegistryConnection | undefined;
  readonly registry: RegistryConnection;
  readonly scopes: readonly RegistryScopeRoute[];
}

function RegistryCreate({ busy, feedback, onSubmit }: { readonly busy: boolean; readonly feedback: { readonly error: boolean; readonly text: string } | undefined; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <AdminPage id="main-content" contentWidth="narrow" aria-busy={busy}>
      <AdminIntegrationBackLink href="/admin/integrations/registries">패키지 저장소</AdminIntegrationBackLink>
      <AdminPageHeader category="패키지 저장소" title="새 패키지 저장소" description="npm 호환 원본과 접근 토큰을 등록한 뒤 상세 화면에서 검증하고 활성화합니다." />
      <AdminConnectionGuide subject="패키지 저장소" />
      <AdminPanel><AdminForm onSubmit={onSubmit} aria-busy={busy}>
        <AdminFormSection title="저장소 정보" description="관리 화면에 표시할 이름과 정확한 npm 호환 HTTPS 주소를 입력합니다.">
          <TextField label="표시 이름" name="displayName" maxLength={200} required disabled={busy} />
          <TextField label="HTTPS 기본 URL" description="npm 호환 레지스트리의 기본 주소" name="baseUrl" type="url" maxLength={2048} required disabled={busy} placeholder="https://registry.example.com" />
        </AdminFormSection>
        <AdminFormSection title="인증 정보" description="패키지 읽기와 게시에 사용할 전용 접근 토큰을 등록합니다.">
          <AdminFormFieldSpan><TextField label="접근 토큰" description="토큰은 저장 후 다시 표시되지 않습니다." name="token" type="password" autoComplete="new-password" maxLength={4096} required disabled={busy} /></AdminFormFieldSpan>
        </AdminFormSection>
        <AdminFormActions><AdminFormActionNote>비활성 상태로 저장되며 완료 후 상세 화면으로 이동합니다.</AdminFormActionNote><Button type="submit" variant="primary" disabled={busy}>저장소 등록</Button></AdminFormActions>
      </AdminForm></AdminPanel>
      {feedback ? <AdminFeedback feedbackTone={feedback.error ? "danger" : "success"} role={feedback.error ? "alert" : "status"}>{feedback.text}</AdminFeedback> : null}
    </AdminPage>
  );
}

function RegistryDetail({ busy, feedback, onActivate, onDelete, onDeleteCancel, onDeleteConfirm, onDisable, onRename, onRotate, onSetDefault, pendingDeletion, registry, scopes }: RegistryDetailProps) {
  const active = registry.state === "active";
  return (
    <AdminPage id="main-content" contentWidth="standard" aria-busy={busy}>
      <AdminIntegrationBackLink href="/admin/integrations/registries">패키지 저장소</AdminIntegrationBackLink>
      <AdminPageHeader
        category="패키지 저장소"
        title={registry.displayName}
        description="패키지 연결 상태, 인증 정보와 적용 중인 스코프를 관리합니다."
        aside={<Badge tone={active ? "success" : "neutral"} variant="status">{active ? "활성" : "비활성"}</Badge>}
      />
      <AdminIntegrationSummary
        state={active ? "active" : "disabled"}
        title={active ? "패키지 요청에 이 저장소를 사용할 수 있습니다" : "패키지 요청에 아직 사용되지 않습니다"}
        description={active ? "활성 연결은 안전을 위해 읽기 전용으로 표시됩니다. 이름이나 토큰을 변경하려면 먼저 비활성화하세요." : "연결 주소와 접근 토큰을 확인한 뒤 실제 레지스트리 검증을 통과하면 활성화할 수 있습니다."}
        metrics={[
          { label: "기본 저장소", value: registry.isDefault ? "사용 중" : "아님" },
          { label: "연결된 스코프", value: `${scopes.length}개` },
          { label: "최근 검증", value: formatRegistryDate(registry.validatedAt) },
          { label: "자격 증명", value: `v${registry.credentialVersion}` }
        ]}
      />
      <AdminIntegrationSection title="저장소 연결" description="npm 호환 HTTPS 원본과 관리 화면에 표시할 이름을 확인합니다.">
        {active ? (
          <AdminIntegrationReadOnlyGrid items={[
            { label: "표시 이름", value: registry.displayName },
            { label: "기본 URL", value: registry.baseUrl },
            { label: "설정 버전", value: `v${registry.configVersion}` },
            { label: "동작 방식", value: "연결 실패 시 다른 저장소로 우회하지 않음" }
          ]} />
        ) : (
          <form className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 max-[42rem]:grid-cols-1" onSubmit={onRename}>
            <TextField label="표시 이름" name="displayName" defaultValue={registry.displayName} maxLength={200} required disabled={busy} />
            <Button disabled={busy}>이름 저장</Button>
          </form>
        )}
      </AdminIntegrationSection>
      <AdminIntegrationSection title="접근 토큰" description="전용 토큰을 교체하면 연결을 다시 검증해야 합니다.">
        {active ? <p className="m-0 text-sm text-muted-foreground">활성 연결의 접근 토큰은 보호되어 있습니다. 토큰을 교체하려면 먼저 저장소를 비활성화하세요.</p> : (
          <form className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 max-[42rem]:grid-cols-1" onSubmit={onRotate}>
            <TextField label="새 접근 토큰" name="token" type="password" autoComplete="new-password" maxLength={4096} required disabled={busy} />
            <Button disabled={busy}>토큰 교체</Button>
          </form>
        )}
      </AdminIntegrationSection>
      <AdminIntegrationSection title="패키지 스코프" description="현재 이 저장소로 고정된 패키지 경로입니다.">
        {scopes.length === 0 ? <p className="m-0 text-sm text-muted-foreground">연결된 스코프가 없습니다. 저장소 목록에서 스코프 경로를 추가할 수 있습니다.</p> : (
          <ul className="m-0 grid list-none gap-2 p-0">{scopes.map((scope) => <li className="rounded-md border border-muted-border bg-subtle px-3 py-2 font-mono text-sm" key={scope.scope}>{scope.scope}</li>)}</ul>
        )}
      </AdminIntegrationSection>
      <AdminIntegrationSection title="TLS 인증서 신뢰" description="사설 인증 기관을 사용하는 레지스트리에만 별도 CA를 등록하세요.">
        <IntegrationCaConsole appearance="detail" type="registry" integrationId={registry.id} />
      </AdminIntegrationSection>
      <AdminSection>
        <AdminIntegrationActionBar note={active ? "비활성화하면 연결된 패키지 경로가 즉시 실패하며 다른 저장소로 자동 우회하지 않습니다." : "활성화 전에 HTTPS, 토큰 권한과 인증서 신뢰를 실제로 검증합니다."}>
          {active ? <Button disabled={busy} onClick={onDisable}>저장소 비활성화</Button> : <Button variant="primary" disabled={busy} onClick={onActivate}>검증 후 활성화</Button>}
          {active && !registry.isDefault ? <Button disabled={busy} onClick={onSetDefault}>기본값으로 설정</Button> : null}
        </AdminIntegrationActionBar>
      </AdminSection>
      <AdminIntegrationDangerSection title="저장소 삭제" description="연결 설정, 접근 토큰과 연결된 스코프 경로를 영구적으로 제거합니다. 먼저 저장소를 비활성화해야 합니다.">
        <Button variant="danger" disabled={busy || active} onClick={onDelete}>저장소 삭제</Button>
      </AdminIntegrationDangerSection>
      {feedback ? <AdminFeedback feedbackTone={feedback.error ? "danger" : "success"} role={feedback.error ? "alert" : "status"}>{feedback.text}</AdminFeedback> : null}
      <ConfirmationDialog busy={busy} confirmLabel={busy ? "삭제 중…" : "저장소 삭제"} description={`${registry.displayName}의 자격 증명과 연결된 스코프 경로가 영구적으로 삭제됩니다.`} open={pendingDeletion !== undefined} title="패키지 저장소를 삭제할까요?" onCancel={onDeleteCancel} onConfirm={onDeleteConfirm} />
    </AdminPage>
  );
}

function formatRegistryDate(value: string | null): string {
  if (value === null) return "검증 기록 없음";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
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
