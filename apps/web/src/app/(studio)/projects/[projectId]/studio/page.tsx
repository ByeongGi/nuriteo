import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Studio" };

interface Props {
  readonly params: Promise<{ projectId: string }>;
  readonly searchParams: Promise<{ workspace?: string | string[] }>;
}

export default async function LegacyProjectStudioPage({ params, searchParams }: Props) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const workspaceId = typeof query.workspace === "string" ? query.workspace : undefined;
  if (workspaceId === undefined || workspaceId.length === 0) redirect("/workspaces");

  redirect(
    `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/studio`
  );
}
