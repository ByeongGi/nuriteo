import type { Metadata } from "next";

import { ProjectGitPanel } from "#src/projects/project-git-panel.tsx";
import { loadProjectContext } from "@/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/_utils/project-context.ts";
import { ProjectSettingsPanel, ProjectSettingsSection } from "@/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/_components/project-settings-section.tsx";

export const metadata: Metadata = { title: "프로젝트 Git 설정" };

export default async function GitSettingsPage({ params }: { readonly params: Promise<{ projectId: string; workspaceId: string }> }) {
  const { projectId, workspaceId } = await params;
  const { project } = await loadProjectContext(workspaceId, projectId);
  return (
    <ProjectSettingsSection
      projectName={project.data.name}
      title="Git 연결"
      description="Git 제공자 자격 증명과 원격 저장소 동기화를 관리합니다."
    >
      <ProjectSettingsPanel>
        <ProjectGitPanel embedded project={project.data} />
      </ProjectSettingsPanel>
    </ProjectSettingsSection>
  );
}
