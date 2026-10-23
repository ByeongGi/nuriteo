import type { Metadata } from "next";

import { Badge } from "#src/components/ui/badge.tsx";
import { loadProjectContext } from "#src/app/(authenticated)/workspaces/[workspaceId]/projects/[projectId]/project-context.ts";
import { ProjectFacts, ProjectSettingsNotice, ProjectSettingsPanel, ProjectSettingsSection } from "#src/app/(authenticated)/workspaces/[workspaceId]/projects/[projectId]/settings/project-settings-section.tsx";

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
      <ProjectSettingsPanel>
        <ProjectFacts items={[{ label: "실행 범위", value: "브라우저 격리 워크스페이스" }, { label: "프로젝트 상태", value: project.data.state === "active" ? "실행 가능" : "보관됨" }, { label: "저장 버전", value: `v${project.data.version}` }, { label: "설정 방식", value: "프로젝트 파일 및 패키지 설정" }]} />
        <p>별도의 서버 런타임 설정 API는 제공하지 않습니다. Node.js 버전과 실행 명령은 프로젝트의 패키지 설정에서 관리하고 Studio를 다시 시작하면 반영됩니다.</p>
      </ProjectSettingsPanel>
    </ProjectSettingsSection>
  );
}
