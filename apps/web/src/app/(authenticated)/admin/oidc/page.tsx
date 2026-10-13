import { listAdminOidcProviders } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { OidcProviderConsole } from "./provider-console.tsx";

export const metadata: Metadata = { title: "Identity providers" };

export default async function OidcProvidersPage() {
  try {
    const providers = await listAdminOidcProviders(await createServerApiClient());
    return <OidcProviderConsole initialProviders={providers.data} />;
  } catch (error) {
    return <EntryUnavailable title="Identity providers are temporarily unavailable" description="No Provider configuration or credential was changed." reference={safeRequestReference(error)} retryHref="/admin/oidc" />;
  }
}
