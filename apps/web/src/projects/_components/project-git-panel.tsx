"use client";

import type { Project } from "@nuriteo/api-client";
import { tv } from "tailwind-variants";

import { Button } from "@/components/ui/button.tsx";
import { SelectField, TextField } from "@/components/ui/field.tsx";
import { useProjectGitPanel } from "@/projects/_hooks/use-project-git-panel.ts";
import type { ProjectGitState } from "@/projects/_hooks/use-project-git-panel.ts";

export type { ProjectGitState };

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

export function ProjectGitPanel({ embedded = false, initialState, project }: Readonly<{
  embedded?: boolean;
  initialState?: ProjectGitState | undefined;
  project: Project;
}>) {
  const styles = gitPanelStyles({ embedded });
  const {
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
  } = useProjectGitPanel(project, initialState);

  return (
    <section className={styles.root()} aria-labelledby="project-git-title">
      <p className={styles.eyebrow()}>서버 연동</p>
      <h3 id="project-git-title">Git 원격 저장소</h3>
      <p>자격 증명은 개발 서버에 한 번만 전송되며 API 응답이나 브라우저 저장소에 남지 않습니다.</p>
      {loading ? <p aria-live="polite">Git 연결을 불러오는 중…</p> : null}
      {feedback ? <p className={styles.feedback({ className: (function () {
    if (feedback.error) {
        return (styles.error());
    }
    return (styles.success());
})() })} role={(function () {
    if (feedback.error) {
        return ("alert");
    }
    return ("status");
})()}>{feedback.text}</p> : null}

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
