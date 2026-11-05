"use client";

import type { Project, Workspace } from "@nuriteo/api-client";
import Link from "next/link";
import { tv } from "tailwind-variants";

import { useProjectGeneralSettings } from "@/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/general/_hooks/use-project-general-settings.ts";
import { ProjectSettingsSection } from "@/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/_components/project-settings-section.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { TextField } from "@/components/ui/field.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/components/ui/settings-group.tsx";

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
  const { feedback, isPending, project, rename } = useProjectGeneralSettings(initialEtag, initialProject);
  const css = styles();
  const projectBase = `/workspaces/${encodeURIComponent(workspace.storageScopeId)}/projects/${encodeURIComponent(project.id)}`;

  return (
    <ProjectSettingsSection projectName={project.name} title="일반 설정" description="프로젝트의 기본 정보와 현재 실행 상태를 관리합니다.">
      {feedback ? <p className={css.feedback({ className: (function () {
    if (feedback.error) {
        return (css.error());
    }
    return (undefined);
})() })} role={(function () {
    if (feedback.error) {
        return ("alert");
    }
    return ("status");
})()}>{feedback.text}</p> : null}
      <SettingsGroup title="프로젝트 정보" description="프로젝트를 식별하고 워크스페이스에 표시되는 정보를 관리합니다.">
        <SettingsRow layout="stacked" title="이름" description="워크스페이스와 Studio에 표시되는 프로젝트 이름입니다.">
          <form className={css.renameForm()} onSubmit={rename} aria-busy={isPending}>
            <TextField density="compact" label="프로젝트 이름" labelHidden name="name" defaultValue={project.name} required maxLength={200} disabled={isPending} />
            <Button type="submit" disabled={isPending}>{isPending ? "저장 중…" : "이름 저장"}</Button>
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
            <Link className={css.link({ className: css.secondary() })} href={`${projectBase}/history`}>버전과 복구 보기</Link>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </ProjectSettingsSection>
  );
}
