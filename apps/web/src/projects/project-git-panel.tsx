"use client";

import {
  ApiError,
  commitAndPushGitRemote,
  connectGitProvider,
  disconnectGitProvider,
  getGitRemote,
  importGitRepository,
  listGitConnections,
  listGitProviders,
  pullGitRemote,
  rotateGitCredential
} from "@nuriteo/api-client";
import type { GitConnection, GitProvider, GitRemote, Project } from "@nuriteo/api-client";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { tv } from "tailwind-variants";

import { Button } from "#src/components/ui/button.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

const gitPanelStyles = tv({
  slots: {
    root: "grid gap-4 border-t border-muted-border pt-5 [&>h3]:m-0 [&>p]:m-0 [&>p]:text-sm [&>p]:text-muted-foreground",
    eyebrow: "text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground",
    feedback: "rounded-lg border px-4 py-3 text-sm",
    form: "grid gap-4 rounded-xl border border-muted-border bg-subtle p-4 [&>h4]:m-0",
    error: "border-danger/25 bg-danger-subtle text-danger",
    success: "border-success/25 bg-success-subtle text-success",
    list: "m-0 grid list-none gap-2 p-0 [&>li]:grid [&>li]:grid-cols-[minmax(0,1fr)_auto] [&>li]:items-center [&>li]:gap-4 [&>li]:rounded-lg [&>li]:border [&>li]:border-muted-border [&>li]:p-4 max-[48rem]:[&>li]:grid-cols-1 [&>li>div:first-child]:grid [&>li>div:first-child]:min-w-0 [&>li>div:first-child>span]:text-sm [&>li>div:first-child>span]:text-muted-foreground",
    actions: "flex flex-wrap items-end justify-end gap-2 max-[48rem]:justify-stretch max-[48rem]:[&>*]:flex-1 [&>form]:flex [&>form]:flex-wrap [&>form]:items-end [&>form]:gap-2"
  },
  variants: {
    embedded: {
      true: { root: "border-t-0 pt-0" },
      false: {}
    }
  }
});

export interface ProjectGitState {
  readonly connections: readonly GitConnection[];
  readonly providers: readonly GitProvider[];
  readonly remote?: GitRemote | undefined;
  readonly remoteEtag?: string | undefined;
}

export function ProjectGitPanel({ embedded = false, initialState, project }: Readonly<{
  embedded?: boolean;
  initialState?: ProjectGitState | undefined;
  project: Project;
}>) {
  const styles = gitPanelStyles({ embedded });
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

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = takeSecret(form, "token");
    const input = new FormData(form);
    await run(async () => {
      const result = await connectGitProvider(
        createBrowserApiClient(),
        String(input.get("providerId") ?? ""),
        token,
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
    await run(async () => {
      const result = await rotateGitCredential(
        createBrowserApiClient(),
        { id: connection.id, etag: connectionEtag(connection) },
        token,
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
    await run(async () => {
      const result = await importGitRepository(createBrowserApiClient(), {
        projectId: project.id,
        repositoryUrl: String(input.get("repositoryUrl") ?? ""),
        branch: String(input.get("branch") ?? "")
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
    const commitMessage = String(new FormData(form).get("commitMessage") ?? "");
    await run(async () => {
      const result = await commitAndPushGitRemote(createBrowserApiClient(), {
        projectId: project.id,
        etag: remoteEtag,
        commitMessage
      }, { csrfToken: readCsrfCredential() });
      setRemote(result.data.remote);
      setRemoteEtag(result.etag);
      form.reset();
      return `${result.data.headSha.slice(0, 12)} 커밋을 원격 저장소에 반영했습니다.`;
    });
  }

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

  const connectedProviderIds = new Set(connections.map((connection) => connection.providerId));
  const availableProviders = providers.filter((provider) => !connectedProviderIds.has(provider.id));
  const activeProvider = remote === undefined
    ? undefined
    : providers.find((provider) => provider.id === remote.providerId);

  return (
    <section className={styles.root()} aria-labelledby="project-git-title">
      <p className={styles.eyebrow()}>서버 연동</p>
      <h3 id="project-git-title">Git 원격 저장소</h3>
      <p>자격 증명은 개발 서버에 한 번만 전송되며 API 응답이나 브라우저 저장소에 남지 않습니다.</p>
      {loading ? <p aria-live="polite">Git 연결을 불러오는 중…</p> : null}
      {feedback ? <p className={styles.feedback({ className: feedback.error ? styles.error() : styles.success() })} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}

      {!loading && availableProviders.length > 0 ? (
        <form className={styles.form()} onSubmit={connect} aria-busy={mutation.isPending}>
          <h4>자격 증명 연결</h4>
          <SelectField
            label="제공자"
            name="providerId"
            options={availableProviders.map((provider) => ({ value: provider.id, label: `${provider.displayName} · ${provider.host}` }))}
            placeholder="제공자 선택"
            required
            disabled={mutation.isPending}
          />
          <TextField label="개인 액세스 토큰" name="token" type="password" autoComplete="off" required maxLength={61_440} disabled={mutation.isPending} />
          <Button type="submit" disabled={mutation.isPending}>Git 연결</Button>
        </form>
      ) : null}

      {connections.length > 0 ? <ul className={styles.list()} aria-label="Git 자격 증명">{connections.map((connection) => {
        const provider = providers.find((item) => item.id === connection.providerId);
        return <li key={connection.id}><div><strong>{provider?.displayName ?? "사용할 수 없는 제공자"}</strong><span>자격 증명 버전 {connection.credentialVersion}</span></div><div className={styles.actions()}><form onSubmit={(event) => void rotate(event, connection)}><TextField label="교체 토큰" labelHidden aria-label={`${provider?.displayName ?? "제공자"} 교체 토큰`} name="token" type="password" autoComplete="off" required maxLength={61_440} disabled={mutation.isPending} /><Button type="submit" disabled={mutation.isPending}>교체</Button></form><Button type="button" variant="danger" disabled={mutation.isPending || remote?.providerId === connection.providerId} onClick={() => void disconnect(connection)}>연결 해제</Button></div></li>;
      })}</ul> : null}

      {!loading && remote === undefined ? (
        <form className={styles.form()} onSubmit={importRepository} aria-busy={mutation.isPending}>
          <h4>저장소 가져오기</h4>
          <TextField label="HTTPS 저장소 URL" name="repositoryUrl" type="url" inputMode="url" required placeholder="https://git.example.com/team/project.git" disabled={mutation.isPending || connections.length === 0} />
          <TextField label="브랜치" name="branch" required defaultValue="main" maxLength={255} disabled={mutation.isPending || connections.length === 0} />
          <Button type="submit" disabled={mutation.isPending || connections.length === 0}>작업 버전으로 가져오기</Button>
        </form>
      ) : null}

      {remote !== undefined ? <div className={styles.form()}><h4>{remote.repositoryUrl}</h4><p>{remote.branch} · {remote.remoteHeadSha.slice(0, 12)} · {activeProvider?.displayName ?? "설정된 제공자"}</p><div className={styles.actions()}><Button type="button" disabled={mutation.isPending} onClick={() => void pull()}>변경사항 가져오기</Button></div><form className="grid gap-3" onSubmit={push}><TextField label="커밋 메시지" name="commitMessage" required maxLength={10_240} disabled={mutation.isPending || activeProvider?.allowsWrite === false} /><Button type="submit" disabled={mutation.isPending || activeProvider?.allowsWrite === false}>커밋하고 반영</Button></form></div> : null}
    </section>
  );
}

function connectionEtag(connection: GitConnection): string {
  return `"git-connection-v${connection.connectionVersion}"`;
}

function takeSecret(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement)) return "";
  const value = field.value;
  field.value = "";
  return value;
}

function gitFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 412) return "원격 저장소가 변경되었습니다. 강제 반영은 시도하지 않았으므로 Git 상태를 새로고침한 뒤 다시 시도하세요.";
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") return "원격 반영 결과를 확인할 수 없습니다. 다시 시도하기 전에 원격 상태를 확인하세요.";
    if (error.code === "REAUTHENTICATION_REQUIRED") return "최근 인증을 갱신하려면 다시 로그인한 뒤 자격 증명 변경을 시도하세요.";
    if (error.status === 401 || error.status === 403) return "현재 세션 또는 프로젝트 권한으로 이 Git 작업을 수행할 수 없습니다.";
    if (error.status === 413) return "Git 전송 크기가 설정된 제한을 초과했습니다.";
  }
  return "Git 작업을 안전하게 완료하지 못했습니다. 자격 증명 정보는 노출되지 않았습니다.";
}
