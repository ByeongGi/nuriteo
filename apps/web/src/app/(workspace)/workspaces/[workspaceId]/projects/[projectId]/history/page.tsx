import { listProjectVersions, listRecoveryCheckpoints } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { loadProjectContext } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/project-context.ts";
import { ProjectHistoryScreen } from "#src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/history/history-screen.tsx";

export const metadata: Metadata = { title: "프로젝트 버전 기록" };

export default async function ProjectHistoryPage({ params }: { readonly params: Promise<{ projectId: string; workspaceId: string }> }) {
  const { projectId, workspaceId } = await params;
  const { client, project, workspace } = await loadProjectContext(workspaceId, projectId);
  const owner = { ownerType: workspace.ownerType, ownerId: workspace.ownerId } as const;
  const [versions, recovery] = await Promise.all([
    listProjectVersions(client, { owner, projectId, pageSize: 20 }),
    listRecoveryCheckpoints(client, { owner, projectId })
  ]);
  return <ProjectHistoryScreen initialState={{ versions: versions.data.items, nextCursor: versions.data.nextCursor, recovery: recovery.data.items }} project={project.data} projectEtag={project.etag} />;
}
