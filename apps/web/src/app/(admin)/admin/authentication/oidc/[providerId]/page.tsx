import { listAdminOidcProviders } from "@nuriteo/api-client";
import { notFound } from "next/navigation";

import { OidcProviderConsole } from "#src/app/(admin)/admin/authentication/oidc/provider-console.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export default async function OidcProviderDetailPage({ params }: { readonly params: Promise<{ readonly providerId: string }> }) {
  const { providerId } = await params;
  const providers = (await listAdminOidcProviders(await createServerApiClient())).data;
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) notFound();
  return <OidcProviderConsole detailMode initialProviders={[provider]} />;
}
