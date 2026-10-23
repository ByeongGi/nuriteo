import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "프로젝트 설정" };

interface Props {
  readonly params: Promise<{ projectId: string }>;
  readonly searchParams: Promise<{
    state?: string | string[];
    workspace?: string | string[];
  }>;
}

export default async function LegacyProjectSettingsPage({ params, searchParams }: Props) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const workspaceId = typeof query.workspace === "string" ? query.workspace : undefined;
  if (workspaceId === undefined || workspaceId.length === 0) redirect("/workspaces");
  const state = query.state === "archived" || query.state === "all" ? query.state : "active";

  redirect(
    `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/settings/general?${new URLSearchParams({ state }).toString()}`
  );
}
