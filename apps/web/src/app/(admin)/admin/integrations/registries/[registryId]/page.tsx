import { listRegistries } from "@nuriteo/api-client";
import { notFound } from "next/navigation";

import { RegistryConsole } from "#src/app/(admin)/admin/registries/registry-console.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export default async function RegistryDetailPage({ params }: { readonly params: Promise<{ readonly registryId: string }> }) {
  const { registryId } = await params;
  const configuration = (await listRegistries(await createServerApiClient())).data;
  const registry = configuration.items.find((item) => item.id === registryId);
  if (!registry) notFound();
  return <RegistryConsole detailMode initialConfiguration={{ items: [registry], scopes: configuration.scopes.filter((scope) => scope.connectionId === registryId) }} />;
}
