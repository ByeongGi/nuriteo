import { listAccessTokens } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { AccessTokenConsole } from "#src/app/(authenticated)/account/tokens/token-console.tsx";
import { loadProjectContext } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/project-context.ts";
import { ProjectSettingsSection } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/project-settings-section.tsx";

export const metadata: Metadata = { title: "프로젝트 토큰" };

export default async function ProjectTokensPage({ params }: { readonly params: Promise<{ projectId: string; workspaceId: string }> }) {
  const { projectId, workspaceId } = await params;
  const { client, project } = await loadProjectContext(workspaceId, projectId);
  const target = { kind: "project", projectId } as const;
  const tokens = await listAccessTokens(client, target);
  return (
    <ProjectSettingsSection
      projectName={project.data.name}
      title="액세스 토큰"
      description="프로젝트 자동화에 필요한 최소 권한 자격 증명을 발급하고 관리합니다."
    >
      <AccessTokenConsole embedded initialTokens={tokens.data} target={target} />
    </ProjectSettingsSection>
  );
}
