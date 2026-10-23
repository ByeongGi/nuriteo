import { redirect } from "next/navigation";

interface LegacyWorkspaceProjectsPageProps {
  readonly params: Promise<{ workspaceId: string }>;
  readonly searchParams: Promise<{ state?: string | string[] }>;
}

export default async function LegacyWorkspaceProjectsPage({ params, searchParams }: LegacyWorkspaceProjectsPageProps) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const state = query.state === "archived" || query.state === "all" ? query.state : "active";
  redirect(`/workspaces/${encodeURIComponent(workspaceId)}?${new URLSearchParams({ state }).toString()}`);
}
