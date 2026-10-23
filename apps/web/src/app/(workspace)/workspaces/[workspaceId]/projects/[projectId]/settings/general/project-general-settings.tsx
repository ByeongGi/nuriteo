"use client";

import { renameProject } from "@nuriteo/api-client";
import type { Project, Workspace } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { tv } from "tailwind-variants";

import { ProjectSettingsSection } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/project-settings-section.tsx";
import { Badge } from "#src/components/ui/badge.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { TextField } from "#src/components/ui/field.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "#src/components/ui/settings-group.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { projectError, readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

const styles = tv({
  slots: {
    renameForm: "grid w-full grid-cols-[minmax(12rem,1fr)_auto] items-end gap-2 max-[36rem]:grid-cols-1",
    feedback: "m-0 rounded-md border border-muted-border bg-surface px-3 py-2 text-xs text-muted-foreground",
    error: "border-danger/35 bg-danger-subtle text-danger",
    actions: "flex flex-wrap justify-end gap-2 max-[42rem]:justify-start",
    link: "inline-flex min-h-8 items-center justify-center rounded-md border px-3 text-xs font-medium no-underline outline-none focus-visible:ring-2 focus-visible:ring-focus",
    primary: "border-primary bg-primary text-on-primary hover:bg-primary-strong",
    secondary: "border-strong-border bg-surface text-foreground hover:bg-hover"
  }
});

export function ProjectGeneralSettings({ initialEtag, initialProject, workspace }: Readonly<{
  initialEtag: string;
  initialProject: Project;
  workspace: Workspace;
}>) {
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [project, setProject] = useState(initialProject);
  const [etag, setEtag] = useState(initialEtag);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const css = styles();
  const projectBase = `/workspaces/${encodeURIComponent(workspace.storageScopeId)}/projects/${encodeURIComponent(project.id)}`;

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (name === project.name) return;
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await renameProject(createBrowserApiClient(), {
          owner: { ownerType: project.ownerType, ownerId: project.ownerId },
          projectId: project.id,
          etag,
          name
        }, { csrfToken: readCsrfCredential() });
        setProject(result.data);
        setEtag(result.etag);
        setFeedback({ error: false, text: "프로젝트 이름을 저장했습니다." });
        router.refresh();
      } catch (error) {
        setFeedback({ error: true, text: projectError(error, "project-profile").message });
      }
    });
  }

  return (
    <ProjectSettingsSection projectName={project.name} title="일반 설정" description="프로젝트의 기본 정보와 현재 실행 상태를 관리합니다.">
      {feedback ? <p className={css.feedback({ className: feedback.error ? css.error() : undefined })} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
      <SettingsGroup title="프로젝트 정보" description="프로젝트를 식별하고 워크스페이스에 표시되는 정보를 관리합니다.">
        <SettingsRow layout="stacked" title="이름" description="워크스페이스와 Studio에 표시되는 프로젝트 이름입니다.">
          <form className={css.renameForm()} onSubmit={rename} aria-busy={mutation.isPending}>
            <TextField density="compact" label="프로젝트 이름" labelHidden name="name" defaultValue={project.name} required maxLength={200} disabled={mutation.isPending} />
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "저장 중…" : "이름 저장"}</Button>
          </form>
        </SettingsRow>
        <SettingsRow title="상태" description="보관된 프로젝트는 Studio에서 수정할 수 없습니다.">
          <Badge size="sm" tone={project.state === "active" ? "success" : "neutral"} variant="status">{project.state === "active" ? "활성" : "보관됨"}</Badge>
        </SettingsRow>
        <SettingsRow title="프로젝트 주소" description="API와 프로젝트 경로에서 사용하는 고유 주소입니다."><SettingsValue>{project.slug}</SettingsValue></SettingsRow>
        <SettingsRow title="워크스페이스"><SettingsValue>{workspace.displayLabel}</SettingsValue></SettingsRow>
        <SettingsRow title="저장 상태" description={`최근 변경 ${new Date(project.updatedAt).toLocaleString("ko-KR")}`}><SettingsValue>v{project.version}</SettingsValue></SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="빠른 작업" description="현재 프로젝트에서 자주 사용하는 화면으로 이동합니다.">
        <SettingsRow title="개발 및 기록" description="Studio에서 개발하거나 이전 저장본을 확인합니다.">
          <div className={css.actions()}>
            {project.state === "active" ? <Link className={css.link({ className: css.primary() })} href={`${projectBase}/studio`}>Studio에서 열기</Link> : null}
            <Link className={css.link({ className: css.secondary() })} href={`${projectBase}/history`}>버전 기록 보기</Link>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </ProjectSettingsSection>
  );
}

