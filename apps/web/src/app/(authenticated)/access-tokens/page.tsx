import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "액세스 토큰" };

export default async function LegacyAccessTokensPage({
  searchParams
}: Readonly<{
  searchParams: Promise<{
    projectId?: string | string[];
    workspace?: string | string[];
  }>;
}>) {
  const query = await searchParams;
  const projectId = singleValue(query.projectId);
  if (projectId === undefined) redirect("/account/tokens");

  const workspaceId = singleValue(query.workspace);
  if (workspaceId === undefined) redirect("/workspaces");

  redirect(
    `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/settings/tokens`
  );
}

function singleValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
