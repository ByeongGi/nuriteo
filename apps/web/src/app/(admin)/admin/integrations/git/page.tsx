import { listGitProvidersForAdmin } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { GitProviderConsole } from "#src/app/(admin)/admin/git-providers/provider-console.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "Git 제공자" };

export default async function GitProvidersPage() {
  try {
    const providers = await listGitProvidersForAdmin(await createServerApiClient());
    return <GitProviderConsole initialProviders={providers.data} />;
  } catch (error) {
    return <EntryUnavailable title="Git 제공자를 일시적으로 사용할 수 없습니다" description="변경된 제공자 설정은 없습니다." reference={safeRequestReference(error)} retryHref="/admin/integrations/git" />;
  }
}
