import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "프로젝트" };

interface Props {
  readonly searchParams: Promise<{
    project?: string | string[];
    state?: string | string[];
    workspace?: string | string[];
  }>;
}

/**
 * Compatibility entry for bookmarks created before projects became
 * workspace-scoped. New links must use the workspace path directly.
 */
export default async function LegacyProjectsPage({ searchParams }: Props) {
  const query = await searchParams;
  const workspaceId = singleValue(query.workspace);
  if (workspaceId === undefined) redirect("/workspaces");

  const state = projectState(query.state);
  const projectId = singleValue(query.project);
  if (projectId !== undefined) {
    redirect(projectSettingsHref(workspaceId, projectId, state));
  }

  redirect(projectsHref(workspaceId, state));
}

function singleValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function projectState(value: string | readonly string[] | undefined): "active" | "archived" | "all" {
  return value === "archived" || value === "all" ? value : "active";
}

function projectsHref(workspaceId: string, state: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/projects?${new URLSearchParams({ state }).toString()}`;
}

function projectSettingsHref(workspaceId: string, projectId: string, state: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/settings/general?${new URLSearchParams({ state }).toString()}`;
}
