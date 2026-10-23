import type { Metadata } from "next";

import { Badge } from "#src/components/ui/badge.tsx";
import { loadProjectContext } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/project-context.ts";
import { ProjectSettingsNotice, ProjectSettingsSection } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/project-settings-section.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "#src/components/ui/settings-group.tsx";

export const metadata: Metadata = { title: "프로젝트 런타임" };

export default async function RuntimeSettingsPage({ params }: { readonly params: Promise<{ projectId: string; workspaceId: string }> }) {
  const { projectId, workspaceId } = await params;
  const { project } = await loadProjectContext(workspaceId, projectId);
  return (
    <ProjectSettingsSection projectName={project.data.name} title="런타임" description="브라우저 런타임에 적용되는 프로젝트 범위와 현재 상태입니다.">
      <ProjectSettingsNotice>
        <p>런타임 설정은 현재 읽기 전용입니다. 지원하지 않는 변경 동작을 제공하지 않습니다.</p>
        <Badge size="sm" tone="neutral" variant="status">읽기 전용</Badge>
      </ProjectSettingsNotice>
      <SettingsGroup title="실행 환경" description="브라우저에서 프로젝트를 실행할 때 적용되는 범위입니다.">
        <SettingsRow title="실행 범위" description="프로젝트마다 분리된 브라우저 런타임을 사용합니다."><SettingsValue>브라우저 격리 워크스페이스</SettingsValue></SettingsRow>
        <SettingsRow title="프로젝트 상태"><SettingsValue>{project.data.state === "active" ? "실행 가능" : "보관됨"}</SettingsValue></SettingsRow>
        <SettingsRow title="저장 버전"><SettingsValue>v{project.data.version}</SettingsValue></SettingsRow>
        <SettingsRow title="설정 위치" description="Node.js 버전과 실행 명령은 프로젝트 파일에서 관리하며 Studio 재시작 후 반영됩니다."><SettingsValue>패키지 설정</SettingsValue></SettingsRow>
      </SettingsGroup>
    </ProjectSettingsSection>
  );
}
