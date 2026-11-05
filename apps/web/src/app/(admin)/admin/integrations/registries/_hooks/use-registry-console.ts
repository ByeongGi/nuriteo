"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { registryCreateSchema, registryRenameSchema, registryScopeSchema, registryTokenSchema } from "@/app/(admin)/admin/integrations/registries/_schema/registry.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { ApiError } from "@/services/http/api.ts";
import { activateRegistry, createRegistry, deleteRegistry, disableRegistry, mapRegistryScope, renameRegistry, rotateRegistryToken, setDefaultRegistry } from "@/services/registries/api.ts";

import type { FormEvent } from "react";
import type { RegistryConfiguration, RegistryConnection, RegistryScopeRoute } from "@nuriteo/api-client";

const validationMessage = "검증에 실패했습니다. HTTPS URL, 토큰, TLS 신뢰와 저장소 네트워크 연결을 확인하세요.";

export function useRegistryConsole({
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
    const parsed = registryCreateSchema.safeParse({
      displayName: String(data.get("displayName") ?? ""),
      baseUrl: String(data.get("baseUrl") ?? ""),
      token: String(data.get("token") ?? "")
    });
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? validationMessage });
      return;
    }
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await createRegistry(createBrowserApiClient(), parsed.data, options());
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
    const parsed = registryRenameSchema.safeParse({ displayName: String(new FormData(event.currentTarget).get("displayName") ?? "") });
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? validationMessage });
      return;
    }
    await run(
      async () => (await renameRegistry(createBrowserApiClient(), registry.id, registry.configVersion, parsed.data.displayName, options())).data,
      "저장소 이름을 변경했습니다."
    );
  }

  async function rotate(event: FormEvent<HTMLFormElement>, registry: RegistryConnection) {
    event.preventDefault();
    const form = event.currentTarget;
    const parsed = registryTokenSchema.safeParse({ token: String(new FormData(form).get("token") ?? "") });
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? validationMessage });
      return;
    }
    await run(
      async () => (await rotateRegistryToken(createBrowserApiClient(), registry.id, registry.configVersion, parsed.data.token, options())).data,
      "토큰을 교체하고 브라우저에서 제거했습니다. 저장소를 다시 검증하세요."
    );
    form.reset();
  }

  async function mapScope(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = registryScopeSchema.safeParse({
      scope: String(data.get("scope") ?? ""),
      connectionId: String(data.get("connectionId") ?? "")
    });
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? validationMessage });
      return;
    }
    const { scope, connectionId } = parsed.data;
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
  const detailRegistry = detailMode ? registries[0] : undefined;
  const detailScopes = detailRegistry === undefined ? [] : scopes.filter((scope) => scope.connectionId === detailRegistry.id);

  return {
    activate: detailRegistry === undefined ? undefined : () => void run(async () => (await activateRegistry(createBrowserApiClient(), detailRegistry.id, detailRegistry.configVersion, options())).data, "저장소를 검증하고 활성화했습니다."),
    active,
    cancelDeletion: () => setPendingDeletion(undefined),
    confirmDeletion: () => { if (pendingDeletion) void remove(pendingDeletion); },
    create,
    detailRegistry,
    detailScopes,
    disable: detailRegistry === undefined ? undefined : () => void run(async () => (await disableRegistry(createBrowserApiClient(), detailRegistry.id, detailRegistry.configVersion, options())).data, "저장소를 즉시 비활성화했습니다. 연결된 경로는 다른 저장소로 우회하지 않습니다."),
    feedback,
    mapScope,
    mutation,
    pendingDeletion,
    registries,
    rename: detailRegistry === undefined ? undefined : (event: FormEvent<HTMLFormElement>) => void rename(event, detailRegistry),
    requestDeletion: (registry: RegistryConnection) => setPendingDeletion(registry),
    rotate: detailRegistry === undefined ? undefined : (event: FormEvent<HTMLFormElement>) => void rotate(event, detailRegistry),
    scopes,
    setDefault: detailRegistry === undefined ? undefined : () => void run(async () => (await setDefaultRegistry(createBrowserApiClient(), detailRegistry.id, detailRegistry.configVersion, options())).data, "기본 저장소를 변경했습니다.")
  };
}

function replaceScope(routes: readonly RegistryScopeRoute[], replacement: RegistryScopeRoute): readonly RegistryScopeRoute[] {
  const remaining = routes.filter((route) => route.scope !== replacement.scope);
  return [...remaining, replacement].toSorted((left, right) => left.scope.localeCompare(right.scope));
}

function registryFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "변경이 완료되었을 수 있습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 412) return { error: true, text: "다른 곳에서 저장소가 변경되었습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { error: true, text: "보안을 위해 다시 로그인한 뒤 저장소 변경을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "이 저장소를 변경할 관리자 권한이 없습니다." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: validationMessage };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "편집하거나 삭제하기 전에 저장소를 비활성화하세요. 활성 스코프 경로는 다른 저장소로 우회하지 않습니다." };
  return { error: true, text: "저장소 변경을 안전하게 완료하지 못했습니다." };
}
