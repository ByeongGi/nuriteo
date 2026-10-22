"use client";

import type { Project } from "@nuriteo/api-client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";

import type { PreviewOriginConfiguration } from "#src/runtime/preview-origin-contract.ts";

const ProjectIdeShell = dynamic(
  () => import("#src/app/(authenticated)/projects/project-ide-shell.tsx").then((module) => module.ProjectIdeShell),
  { loading: () => <div className="studio-loading" role="status">Studio를 준비하는 중…</div>, ssr: false }
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
  const overviewHref = `/projects/${encodeURIComponent(project.id)}?${new URLSearchParams({ workspace: workspaceScope }).toString()}`;

  return (
    <main id="main-content" className="studio-screen" tabIndex={-1}>
      <header className="studio-screen__bar">
        <div className="studio-screen__identity">
          <Link href={overviewHref} className="studio-screen__back" aria-label="프로젝트 개요로 돌아가기">‹</Link>
          <div>
            <strong>{project.name}</strong>
            <span>{workspaceLabel} / {project.slug} · v{project.version}</span>
          </div>
        </div>
        <nav aria-label="Studio 프로젝트 메뉴">
          <Link href={overviewHref}>프로젝트 설정</Link>
          <Link href={`/access-tokens?projectId=${encodeURIComponent(project.id)}`}>액세스 토큰</Link>
        </nav>
      </header>
      <section className="studio-screen__workspace" aria-label={`${project.name} Studio`}>
        {children}
      </section>
    </main>
  );
}
