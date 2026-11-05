"use client";

import type { Project } from "@nuriteo/api-client";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { useProjectStudioScreen } from "@/app/(studio)/projects/[projectId]/studio/_hooks/use-project-studio-screen.ts";

import type { PreviewOriginConfiguration } from "@/runtime/preview-origin-contract.ts";

const studioFrameStyles = tv({
  slots: {
    root: "grid h-dvh min-h-0 min-w-0 grid-rows-[2.75rem_minmax(0,1fr)] overflow-hidden bg-page text-foreground",
    bar: "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-muted-border bg-sidebar px-2.5 max-[40rem]:gap-2",
    identity: "flex min-w-0 items-center gap-3",
    identityCopy: "flex min-w-0 items-center gap-2 [&_strong]:max-w-[min(34vw,32rem)] [&_strong]:truncate [&_strong]:text-xs [&_strong]:font-semibold [&_strong]:text-foreground [&_span]:max-w-[min(28vw,28rem)] [&_span]:truncate [&_span]:text-[0.6875rem] [&_span]:text-muted-foreground",
    back: "grid size-7 shrink-0 place-items-center rounded text-sm leading-none text-muted-foreground no-underline hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
    studioMark: "grid size-6 shrink-0 place-items-center rounded bg-primary text-[0.6875rem] font-bold text-on-primary shadow-sm",
    divider: "text-muted-foreground/40",
    navigation: "flex items-center gap-1",
    navigationLink: "rounded border border-transparent px-2.5 py-1.5 text-[0.6875rem] font-semibold text-muted-foreground no-underline hover:border-muted-border hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary max-[32rem]:px-2",
    workspace: "min-h-0 min-w-0 overflow-hidden",
    loading: "grid min-h-[calc(100vh-3rem)] place-items-center bg-surface text-muted-foreground"
  }
});

const studioStyles = studioFrameStyles();

const ProjectIdeShell = dynamic(
  () => import("@/projects/project-ide-shell.tsx").then((module) => module.ProjectIdeShell),
  { loading: () => <div className={studioStyles.loading()} role="status">Studio를 준비하는 중…</div>, ssr: false }
);

interface Props {
  readonly previewConfiguration: PreviewOriginConfiguration;
  readonly project: Project;
  readonly projectEtag: string;
  readonly runtimeAssetRevision?: string;
  readonly workspaceLabel: string;
  readonly workspaceScope: string;
}

export function ProjectStudioScreen(props: Props) {
  const { commitProject, etag, project, reloadProject } = useProjectStudioScreen(props.project, props.projectEtag);

  return (
    <ProjectStudioFrame project={project} workspaceLabel={props.workspaceLabel} workspaceScope={props.workspaceScope}>
        <ProjectIdeShell
          key={`${props.workspaceScope}:${project.id}:${project.state}`}
          {...(props.runtimeAssetRevision === undefined ? {} : { assetRevision: props.runtimeAssetRevision })}
          previewConfiguration={props.previewConfiguration}
          project={project}
          projectEtag={etag}
          onProjectCommit={commitProject}
          onProjectReload={reloadProject}
          workspaceScope={props.workspaceScope}
        />
    </ProjectStudioFrame>
  );
}

export function ProjectStudioFrame({ children, project, workspaceLabel, workspaceScope }: Readonly<{
  children: ReactNode;
  project: Project;
  workspaceLabel: string;
  workspaceScope: string;
}>) {
  const workspaceHref = `/workspaces/${encodeURIComponent(workspaceScope)}`;
  const projectBaseHref = `${workspaceHref}/projects`;
  const settingsHref = `${projectBaseHref}/${encodeURIComponent(project.id)}/settings`;
  const historyHref = `${projectBaseHref}/${encodeURIComponent(project.id)}/history`;

  return (
    <main id="main-content" className={studioStyles.root()} tabIndex={-1}>
      <header className={studioStyles.bar()}>
        <div className={studioStyles.identity()}>
          <Link href={workspaceHref} className={studioStyles.back()} aria-label={`${workspaceLabel} 프로젝트 목록으로 돌아가기`}>←</Link>
          <span className={studioStyles.studioMark()} aria-hidden="true">S</span>
          <div className={studioStyles.identityCopy()}>
            <strong>{project.name}</strong>
            <span className={studioStyles.divider()} aria-hidden="true">/</span>
            <span>{workspaceLabel} · {project.slug} · v{project.version}</span>
          </div>
        </div>
        <nav className={studioStyles.navigation()} aria-label="Studio 프로젝트 메뉴">
          <Link className={studioStyles.navigationLink()} href={historyHref}>버전과 복구</Link>
          <Link className={studioStyles.navigationLink()} href={settingsHref}>프로젝트 관리</Link>
        </nav>
      </header>
      <section className={studioStyles.workspace()} aria-label={`${project.name} Studio`}>
        {children}
      </section>
    </main>
  );
}
