import type { Metadata } from "next";

import { loadProjectContext } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/project-context.ts";
import { ProjectGeneralSettings } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/general/project-general-settings.tsx";

export const metadata: Metadata = { title: "프로젝트 일반 설정" };

interface Props {
  readonly params: Promise<{ projectId: string; workspaceId: string }>;
}

export default async function GeneralSettingsPage({ params }: Props) {
  const { projectId, workspaceId } = await params;
  const { project, workspace } = await loadProjectContext(workspaceId, projectId);
  return <ProjectGeneralSettings initialEtag={project.etag} initialProject={project.data} workspace={workspace} />;
}
