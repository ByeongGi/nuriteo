"use client";

import type { Project } from "@nuriteo/api-client";

import { useHistoryScreen } from "@/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/history/_hooks/use-history-screen.ts";
import { ProjectSettingsSection } from "@/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/_components/project-settings-section.tsx";
import { ProjectHistoryPanel } from "@/projects/_components/project-history-panel.tsx";

import type { ProjectHistoryState } from "@/projects/_components/project-history-panel.tsx";

export function ProjectHistoryScreen({ initialState, project, projectEtag }: Readonly<{ initialState: ProjectHistoryState; project: Project; projectEtag: string }>) {
  const { currentProject, etag, reloadProject, updateHead } = useHistoryScreen(project, projectEtag);

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
        onReloadProject={reloadProject}
        onResumeRestoredSave={updateHead}
      />
    </ProjectSettingsSection>
  );
}
