"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { gitProviderCreateSchema, gitProviderUpdateSchema } from "@/app/(admin)/admin/integrations/git/_schema/git-provider.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { activateGitProvider, createGitProvider, deleteGitProvider, disableGitProvider, updateGitProvider } from "@/services/git-providers/api.ts";
import { ApiError } from "@/services/http/api.ts";

import type { FormEvent } from "react";
import type { GitProviderAdmin, GitProviderKind } from "@nuriteo/api-client";

const validationMessage = "Git 제공자 변경을 안전하게 완료하지 못했습니다.";

export function useGitProviderForm(initialKind: GitProviderKind = "generic") {
  const [kind, setKind] = useState<GitProviderKind>(initialKind);
  return { kind, setKind };
}

export function useGitProviderConsole({
  createMode = false,
  detailMode = false,
  initialProviders
}: {
  readonly createMode?: boolean;
  readonly detailMode?: boolean;
  readonly initialProviders: readonly GitProviderAdmin[];
}) {
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
    const parsed = gitProviderCreateSchema.safeParse(input(new FormData(form)));
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? validationMessage });
      return;
    }
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await createGitProvider(createBrowserApiClient(), parsed.data, options());
        setProviders((items) => [...items, result.data]);
        form.reset();
        setFeedback({ error: false, text: "제공자를 비활성 상태로 저장했습니다. 필요하면 사설 CA 신뢰를 구성한 뒤 검증하고 활성화하세요." });
        if (createMode) router.replace(`/admin/integrations/git/${result.data.id}`);
      } catch (error) { setFeedback(failure(error)); }
    });
  }

  async function update(event: FormEvent<HTMLFormElement>, provider: GitProviderAdmin) {
    event.preventDefault();
    const value = input(new FormData(event.currentTarget));
    const parsed = gitProviderUpdateSchema.safeParse({
      displayName: value.displayName,
      apiBaseUrl: value.apiBaseUrl,
      oauthAuthorizationUrl: value.oauthAuthorizationUrl,
      oauthTokenUrl: value.oauthTokenUrl,
      oauthClientId: value.oauthClientId,
      allowsRead: value.allowsRead,
      allowsWrite: value.allowsWrite
    });
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? validationMessage });
      return;
    }
    await execute(async () => (await updateGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, parsed.data, options())).data, "제공자 정보를 변경했습니다. 사용하기 전에 검증하세요.");
  }

  async function remove(provider: GitProviderAdmin) {
    await mutation.run(async () => {
      try {
        await deleteGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, options());
        setProviders((items) => items.filter((item) => item.id !== provider.id));
        setPendingDeletion(undefined);
        if (detailMode) router.replace("/admin/integrations/git");
      } catch (error) { setFeedback(failure(error)); }
    });
  }

  const detailProvider = detailMode ? providers[0] : undefined;

  return {
    activate: detailProvider === undefined ? undefined : () => void execute(async () => (await activateGitProvider(createBrowserApiClient(), detailProvider.id, detailProvider.configVersion, options())).data, "제공자를 검증하고 활성화했습니다."),
    cancelDeletion: () => setPendingDeletion(undefined),
    confirmDeletion: () => { if (pendingDeletion) void remove(pendingDeletion); },
    create,
    detailProvider,
    disable: detailProvider === undefined ? undefined : () => void execute(async () => (await disableGitProvider(createBrowserApiClient(), detailProvider.id, detailProvider.configVersion, options())).data, "제공자를 즉시 비활성화했습니다."),
    feedback,
    mutation,
    pendingDeletion,
    providers,
    requestDeletion: (provider: GitProviderAdmin) => setPendingDeletion(provider),
    update: detailProvider === undefined ? undefined : (event: FormEvent<HTMLFormElement>) => void update(event, detailProvider)
  };
}

function input(data: FormData) {
  const nullable = (name: string) => String(data.get(name) ?? "").trim() || null;
  return {
    displayName: String(data.get("displayName") ?? ""),
    kind: String(data.get("kind") ?? "generic") as GitProviderKind,
    host: String(data.get("host") ?? ""),
    port: Number(data.get("port") ?? 443),
    apiBaseUrl: String(data.get("apiBaseUrl") ?? ""),
    oauthAuthorizationUrl: nullable("oauthAuthorizationUrl"),
    oauthTokenUrl: nullable("oauthTokenUrl"),
    oauthClientId: nullable("oauthClientId"),
    allowsRead: data.has("allowsRead"),
    allowsWrite: data.has("allowsWrite")
  };
}

function failure(error: unknown) {
  if (error instanceof ApiError && error.status === 412) return { error: true, text: "다른 곳에서 제공자가 변경되었습니다. 새로 불러온 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { error: true, text: "보안을 위해 다시 로그인한 뒤 Git 제공자 변경을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "이 Git 제공자를 변경할 관리자 권한이 없습니다." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "편집하거나 삭제하기 전에 제공자를 비활성화하세요." };
  return { error: true, text: validationMessage };
}
