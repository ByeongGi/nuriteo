import { listGitProvidersForAdmin } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { GitProviderConsole } from "./provider-console.tsx";

export const metadata: Metadata = { title: "Git providers" };

export default async function GitProvidersPage() {
  try {
    const providers = await listGitProvidersForAdmin(await createServerApiClient());
    return <GitProviderConsole initialProviders={providers.data} />;
  } catch (error) {
    return <EntryUnavailable title="Git providers are temporarily unavailable" description="No provider configuration was changed." reference={safeRequestReference(error)} retryHref="/admin/git-providers" />;
  }
}
