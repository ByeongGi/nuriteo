import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "워크스페이스" };

interface Props {
  readonly params: Promise<{ workspaceId: string }>;
  readonly searchParams: Promise<{ state?: string | string[] }>;
}

/** Workspace entry points resolve to their primary resource collection. */
export default async function WorkspacePage({ params, searchParams }: Props) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const state = query.state === "archived" || query.state === "all" ? query.state : "active";
  redirect(
    `/workspaces/${encodeURIComponent(workspaceId)}/projects?${new URLSearchParams({ state }).toString()}`
  );
}
