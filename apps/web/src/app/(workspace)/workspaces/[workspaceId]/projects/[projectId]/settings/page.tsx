import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "프로젝트 설정" };

export default async function ProjectSettingsPage({ params }: { readonly params: Promise<{ projectId: string; workspaceId: string }> }) {
  const { projectId, workspaceId } = await params;
  redirect(`/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/settings/general`);
}
