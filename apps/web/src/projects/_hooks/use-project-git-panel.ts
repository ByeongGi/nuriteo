"use client";

import { useEffect, useState } from "react";

import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { gitCommitSchema, gitConnectSchema, gitImportSchema, gitRotateTokenSchema } from "@/projects/_schema/project-git.ts";
import { connectionEtag, gitFailureMessage, takeSecret } from "@/projects/_utils/project-git.ts";
import {
  commitAndPushGitRemote,
  connectGitProvider,
  disconnectGitProvider,
  getGitRemote,
  importGitRepository,
  listGitConnections,
  listGitProviders,
  pullGitRemote,
  rotateGitCredential
} from "@/services/git/api.ts";
import { ApiError } from "@/services/http/api.ts";

import type { FormEvent } from "react";
import type { GitConnection, GitProvider, GitRemote, Project } from "@nuriteo/api-client";

export interface ProjectGitState {
  readonly connections: readonly GitConnection[];
  readonly providers: readonly GitProvider[];
  readonly remote?: GitRemote | undefined;
  readonly remoteEtag?: string | undefined;
}

export function useProjectGitPanel(project: Project, initialState?: ProjectGitState | undefined) {
  const mutation = useExclusiveMutation();
  const [providers, setProviders] = useState<readonly GitProvider[]>(initialState?.providers ?? []);
  const [connections, setConnections] = useState<readonly GitConnection[]>(initialState?.connections ?? []);
  const [remote, setRemote] = useState<GitRemote | undefined>(initialState?.remote);
  const [remoteEtag, setRemoteEtag] = useState<string | undefined>(initialState?.remoteEtag);
  const [loading, setLoading] = useState(initialState === undefined);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();

  useEffect(() => {
    if (initialState !== undefined) {
      setProviders(initialState.providers);
      setConnections(initialState.connections);
      setRemote(initialState.remote);
      setRemoteEtag(initialState.remoteEtag);
      setLoading(false);
      setFeedback(undefined);
      return;
    }

    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setFeedback(undefined);
      try {
        const client = createBrowserApiClient();
        const [providerResult, connectionResult, remoteResult] = await Promise.all([
          listGitProviders(client, { signal: controller.signal }),
          listGitConnections(client, { signal: controller.signal }),
          getGitRemote(client, project.id, { signal: controller.signal }).catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 404) return undefined;
            throw error;
          })
        ]);
        setProviders(providerResult.data);
        setConnections(connectionResult.data);
        setRemote(remoteResult?.data);
        setRemoteEtag(remoteResult?.etag);
      } catch (error) {
        if (!controller.signal.aborted) {
          setFeedback({ error: true, text: gitFailureMessage(error) });
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [initialState, project.id]);

  async function run(action: () => Promise<string>) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        setFeedback({ error: false, text: await action() });
      } catch (error) {
        setFeedback({ error: true, text: gitFailureMessage(error) });
      }
    });
  }

  function rejectForm(message: string | undefined) {
    setFeedback({ error: true, text: message ?? "입력값을 확인하세요." });
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = takeSecret(form, "token");
    const input = new FormData(form);
    const parsed = gitConnectSchema.safeParse({
      providerId: String(input.get("providerId") ?? ""),
      token
    });
    if (!parsed.success) {
      rejectForm(parsed.error.issues[0]?.message);
      return;
    }
    await run(async () => {
      const result = await connectGitProvider(
        createBrowserApiClient(),
        parsed.data.providerId,
        parsed.data.token,
        { csrfToken: readCsrfCredential() }
      );
      setConnections((items) => [...items, result.data]);
      form.reset();
      return "Git 자격 증명을 연결했습니다. 토큰 원문은 다시 표시되지 않습니다.";
    });
  }

  async function rotate(event: FormEvent<HTMLFormElement>, connection: GitConnection) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = takeSecret(form, "token");
    const parsed = gitRotateTokenSchema.safeParse({ token });
    if (!parsed.success) {
      rejectForm(parsed.error.issues[0]?.message);
      return;
    }
    await run(async () => {
      const result = await rotateGitCredential(
        createBrowserApiClient(),
        { id: connection.id, etag: connectionEtag(connection) },
        parsed.data.token,
        { csrfToken: readCsrfCredential() }
      );
      setConnections((items) => items.map((item) => item.id === connection.id ? result.data : item));
      form.reset();
      return "Git 자격 증명을 교체했습니다.";
    });
  }

  async function disconnect(connection: GitConnection) {
    await run(async () => {
      await disconnectGitProvider(
        createBrowserApiClient(),
        { id: connection.id, etag: connectionEtag(connection) },
        { csrfToken: readCsrfCredential() }
      );
      setConnections((items) => items.filter((item) => item.id !== connection.id));
      return "Git 자격 증명 연결을 해제했습니다.";
    });
  }

  async function importRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = new FormData(event.currentTarget);
    const parsed = gitImportSchema.safeParse({
      repositoryUrl: String(input.get("repositoryUrl") ?? ""),
      branch: String(input.get("branch") ?? "")
    });
    if (!parsed.success) {
      rejectForm(parsed.error.issues[0]?.message);
      return;
    }
    await run(async () => {
      const result = await importGitRepository(createBrowserApiClient(), {
        projectId: project.id,
        repositoryUrl: parsed.data.repositoryUrl,
        branch: parsed.data.branch
      }, { csrfToken: readCsrfCredential() });
      setRemote(result.data.remote);
      setRemoteEtag(result.etag);
      return `Git 객체 ${result.data.changedObjects}개를 프로젝트 작업 버전으로 가져왔습니다.`;
    });
  }

  async function pull() {
    if (remoteEtag === undefined) return;
    await run(async () => {
      const result = await pullGitRemote(
        createBrowserApiClient(),
        project.id,
        remoteEtag,
        { csrfToken: readCsrfCredential() }
      );
      setRemote(result.data.remote);
      setRemoteEtag(result.etag);
      return `변경된 Git 객체 ${result.data.changedObjects}개를 가져왔습니다.`;
    });
  }

  async function push(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (remoteEtag === undefined) return;
    const form = event.currentTarget;
    const parsed = gitCommitSchema.safeParse({
      commitMessage: String(new FormData(form).get("commitMessage") ?? "")
    });
    if (!parsed.success) {
      rejectForm(parsed.error.issues[0]?.message);
      return;
    }
    await run(async () => {
      const result = await commitAndPushGitRemote(createBrowserApiClient(), {
        projectId: project.id,
        etag: remoteEtag,
        commitMessage: parsed.data.commitMessage
      }, { csrfToken: readCsrfCredential() });
      setRemote(result.data.remote);
      setRemoteEtag(result.etag);
      form.reset();
      return `${result.data.headSha.slice(0, 12)} 커밋을 원격 저장소에 반영했습니다.`;
    });
  }

  const connectedProviderIds = new Set(connections.map((connection) => connection.providerId));
  const availableProviders = providers.filter((provider) => !connectedProviderIds.has(provider.id));
  const activeProvider = remote === undefined
    ? undefined
    : providers.find((provider) => provider.id === remote.providerId);

  return {
    activeProvider,
    availableProviders,
    connect,
    connections,
    disconnect,
    feedback,
    importRepository,
    loading,
    mutation,
    providers,
    pull,
    push,
    remote,
    rotate
  };
}
