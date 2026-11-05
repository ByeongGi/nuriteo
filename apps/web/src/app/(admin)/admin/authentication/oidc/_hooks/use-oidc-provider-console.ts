"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { oidcProviderCreateSchema, oidcProviderSecretSchema, oidcProviderUpdateSchema } from "@/app/(admin)/admin/authentication/oidc/_schema/oidc-provider.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { ApiError } from "@/services/http/api.ts";
import { activateOidcProvider, createOidcProvider, deleteOidcProvider, disableOidcProvider, rotateOidcProviderSecret, updateOidcProvider } from "@/services/oidc/api.ts";

import type { FormEvent } from "react";
import type { OidcProvider } from "@nuriteo/api-client";

const validationMessage = "검증에 실패했습니다. HTTPS 발급자, 클라이언트 설정, 리디렉션 URI와 제공자 네트워크 연결을 확인하세요.";

export function useOidcProviderConsole({
  createMode = false,
  detailMode = false,
  initialProviders
}: {
  readonly createMode?: boolean;
  readonly detailMode?: boolean;
  readonly initialProviders: readonly OidcProvider[];
}) {
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
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const parsed = oidcProviderCreateSchema.safeParse({
      displayName: String(data.get("displayName") ?? ""),
      issuer: String(data.get("issuer") ?? ""),
      clientId: String(data.get("clientId") ?? ""),
      clientSecret: String(data.get("clientSecret") ?? "")
    });
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? validationMessage });
      return;
    }
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await createOidcProvider(createBrowserApiClient(), parsed.data, options());
        setProviders((items) => [...items, result.data]);
        form.reset();
        setFeedback({ error: false, text: "제공자를 비활성 상태로 저장했습니다. 사용자가 로그인하기 전에 검증하고 활성화하세요." });
        if (createMode) router.replace(`/admin/authentication/oidc/${result.data.id}`);
      } catch (error) { setFeedback(providerFailure(error)); }
    });
  }

  async function update(event: FormEvent<HTMLFormElement>, provider: OidcProvider) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = oidcProviderUpdateSchema.safeParse({
      displayName: String(data.get("displayName") ?? ""),
      clientId: String(data.get("clientId") ?? "")
    });
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? validationMessage });
      return;
    }
    await run(async () => (await updateOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, parsed.data, options())).data, "제공자 정보를 변경했습니다. 검증을 통과할 때까지 비활성 상태로 유지됩니다.");
  }

  async function rotate(event: FormEvent<HTMLFormElement>, provider: OidcProvider) {
    event.preventDefault();
    const form = event.currentTarget;
    const parsed = oidcProviderSecretSchema.safeParse({ clientSecret: String(new FormData(form).get("clientSecret") ?? "") });
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? validationMessage });
      return;
    }
    await run(async () => (await rotateOidcProviderSecret(createBrowserApiClient(), provider.id, provider.configVersion, parsed.data.clientSecret, options())).data, "클라이언트 비밀키를 교체했습니다. 제공자를 다시 검증하고 활성화하세요.");
    form.reset();
  }

  async function remove(provider: OidcProvider) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        await deleteOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, options());
        setProviders((items) => items.filter((item) => item.id !== provider.id));
        setPendingDeletion(undefined);
        setFeedback({ error: false, text: "제공자를 삭제했습니다." });
        if (detailMode) router.replace("/admin/authentication/oidc");
      } catch (error) { setFeedback(providerFailure(error)); }
    });
  }

  const detailProvider = detailMode ? providers[0] : undefined;

  return {
    activate: detailProvider === undefined ? undefined : () => void run(async () => (await activateOidcProvider(createBrowserApiClient(), detailProvider.id, detailProvider.configVersion, `${window.location.origin}/api/v1/auth/oidc/${detailProvider.id}/callback`, options())).data, "제공자를 검증하고 활성화했습니다."),
    cancelDeletion: () => setPendingDeletion(undefined),
    confirmDeletion: () => { if (pendingDeletion) void remove(pendingDeletion); },
    create,
    detailProvider,
    disable: detailProvider === undefined ? undefined : () => void run(async () => (await disableOidcProvider(createBrowserApiClient(), detailProvider.id, detailProvider.configVersion, options())).data, "제공자를 즉시 비활성화했습니다."),
    feedback,
    mutation,
    pendingDeletion,
    providers,
    removeDetail: detailProvider === undefined ? undefined : () => void remove(detailProvider),
    requestDeletion: (provider: OidcProvider) => setPendingDeletion(provider),
    rotate: detailProvider === undefined ? undefined : (event: FormEvent<HTMLFormElement>) => void rotate(event, detailProvider),
    update: detailProvider === undefined ? undefined : (event: FormEvent<HTMLFormElement>) => void update(event, detailProvider)
  };
}

function providerFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "변경이 완료되었을 수 있습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 412) return { error: true, text: "다른 곳에서 제공자가 변경되었습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { error: true, text: "보안을 위해 다시 로그인한 뒤 제공자 변경을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "이 제공자를 변경할 관리자 권한이 없습니다." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: validationMessage };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "먼저 제공자를 비활성화하고 연결된 계정을 제거한 뒤 삭제하세요." };
  return { error: true, text: "제공자 변경을 안전하게 완료하지 못했습니다." };
}
