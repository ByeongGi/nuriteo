"use client";

import type { Project } from "@nuriteo/api-client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import type { PreviewOriginConfiguration } from "#src/runtime/preview-origin-contract.ts";

const studioFrameStyles = tv({
  slots: {
    root: "grid min-h-screen min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-page",
    bar: "flex min-h-15 items-center justify-between gap-4 border-b border-muted-border bg-sidebar px-4 py-2 max-[40rem]:items-start max-[40rem]:gap-2 max-[40rem]:px-3",
    identity: "flex min-w-0 items-center gap-3",
    identityCopy: "flex min-w-0 flex-col items-start [&_strong]:max-w-[min(55vw,42rem)] [&_strong]:truncate [&_span]:max-w-[min(55vw,42rem)] [&_span]:truncate [&_span]:text-xs [&_span]:text-muted-foreground",
    back: "grid size-8 shrink-0 place-items-center rounded-md border border-muted-border text-xl leading-none text-foreground no-underline hover:bg-hover",
    navigation: "flex items-center gap-1 max-[40rem]:grid max-[40rem]:justify-items-end",
    navigationLink: "rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground no-underline hover:bg-hover hover:text-foreground max-[40rem]:px-2 max-[40rem]:py-1.5 max-[40rem]:text-xs",
    workspace: "min-w-0 p-3 max-[40rem]:p-2",
    loading: "grid min-h-[calc(100vh-6rem)] place-items-center text-muted-foreground"
  }
});

const studioStyles = studioFrameStyles();

const ProjectIdeShell = dynamic(
  () => import("#src/app/(authenticated)/projects/project-ide-shell.tsx").then((module) => module.ProjectIdeShell),
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
  const router = useRouter();
  const [project, setProject] = useState(props.project);
  const [etag, setEtag] = useState(props.projectEtag);

  return (
    <ProjectStudioFrame project={project} workspaceLabel={props.workspaceLabel} workspaceScope={props.workspaceScope}>
        <ProjectIdeShell
          key={`${props.workspaceScope}:${project.id}:${project.state}`}
          {...(props.runtimeAssetRevision === undefined ? {} : { assetRevision: props.runtimeAssetRevision })}
          previewConfiguration={props.previewConfiguration}
          project={project}
          projectEtag={etag}
          onProjectCommit={(result) => {
            setEtag(result.projectEtag);
            setProject((current) => ({ ...current, version: result.projectVersion }));
          }}
          onProjectReload={() => router.refresh()}
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
  const projectBaseHref = `/workspaces/${encodeURIComponent(workspaceScope)}/projects`;
  const settingsHref = `${projectBaseHref}/${encodeURIComponent(project.id)}/settings`;

  return (
    <main id="main-content" className={studioStyles.root()} tabIndex={-1}>
      <header className={studioStyles.bar()}>
        <div className={studioStyles.identity()}>
          <Link href={projectBaseHref} className={studioStyles.back()} aria-label={`${workspaceLabel} 프로젝트 목록으로 돌아가기`}>‹</Link>
          <div className={studioStyles.identityCopy()}>
            <strong>{project.name}</strong>
            <span>{workspaceLabel} / {project.slug} · v{project.version}</span>
          </div>
        </div>
        <nav className={studioStyles.navigation()} aria-label="Studio 프로젝트 메뉴">
          <Link className={studioStyles.navigationLink()} href={settingsHref}>프로젝트 설정</Link>
          <Link className={studioStyles.navigationLink()} href={`${projectBaseHref}/${encodeURIComponent(project.id)}/settings/tokens`}>액세스 토큰</Link>
        </nav>
      </header>
      <section className={studioStyles.workspace()} aria-label={`${project.name} Studio`}>
        {children}
      </section>
    </main>
  );
}
