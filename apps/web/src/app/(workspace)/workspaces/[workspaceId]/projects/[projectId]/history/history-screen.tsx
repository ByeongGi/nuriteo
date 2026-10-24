"use client";

import type { Project } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ProjectHistoryPanel } from "#src/app/(authenticated)/projects/project-history-panel.tsx";
import type { ProjectHistoryState, RestoredProjectHead } from "#src/app/(authenticated)/projects/project-history-panel.tsx";
import { ProjectSettingsSection } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/project-settings-section.tsx";

export function ProjectHistoryScreen({ initialState, project, projectEtag }: Readonly<{ initialState: ProjectHistoryState; project: Project; projectEtag: string }>) {
  const router = useRouter();
  const [etag, setEtag] = useState(projectEtag);
  const [version, setVersion] = useState(project.version);
  const currentProject = version === project.version ? project : { ...project, version };
  const updateHead = (head: RestoredProjectHead) => {
    setEtag(head.projectEtag);
    setVersion(head.projectVersion);
  };

  return (
    <ProjectSettingsSection
      projectName={project.name}
      title="버전과 복구"
      description="서버 저장본의 명시적 버전과 자동 복구 지점을 확인하고 복구합니다."
    >
      <ProjectHistoryPanel
        density="compact"
        hasLocalDraft={false}
        initialState={initialState}
        project={currentProject}
        projectEtag={etag}
        onProjectCommit={updateHead}
        onReloadProject={() => router.refresh()}
        onResumeRestoredSave={updateHead}
      />
    </ProjectSettingsSection>
  );
}
