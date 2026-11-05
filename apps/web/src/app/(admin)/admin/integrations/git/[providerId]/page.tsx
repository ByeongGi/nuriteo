import { listGitProvidersForAdmin } from "@/services/git-providers/api.ts";

import { notFound } from "next/navigation";

import { GitProviderConsole } from "@/app/(admin)/admin/integrations/git/_components/provider-console.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export default async function GitProviderDetailPage({ params }: { readonly params: Promise<{ readonly providerId: string }> }) {
  const { providerId } = await params;
  const providers = (await listGitProvidersForAdmin(await createServerApiClient())).data;
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) notFound();
  return <GitProviderConsole detailMode initialProviders={[provider]} />;
}
