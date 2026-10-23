import type { Metadata } from "next";

import { ProjectDashboard } from "#src/app/(authenticated)/projects/project-dashboard.tsx";
import { loadProjectContext } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/project-context.ts";

export const metadata: Metadata = { title: "프로젝트 위험 영역" };

export default async function DangerSettingsPage({ params }: { readonly params: Promise<{ projectId: string; workspaceId: string }> }) {
  const { projectId, workspaceId } = await params;
  const { project, workspace, workspaces } = await loadProjectContext(workspaceId, projectId);
  return <ProjectDashboard key={`${project.data.id}:${project.data.version}:danger`} detailSection="danger" initialProject={project.data} initialProjectEtag={project.etag} selectedScope={workspace.storageScopeId} workspaces={workspaces} />;
}
