import { listAdminOidcProviders } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { OidcProviderConsole } from "#src/app/(admin)/admin/authentication/oidc/provider-console.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "OIDC 제공자" };

export default async function OidcProvidersPage() {
  try {
    const providers = await listAdminOidcProviders(await createServerApiClient());
    return <OidcProviderConsole initialProviders={providers.data} />;
  } catch (error) {
    return <EntryUnavailable title="인증 제공자를 일시적으로 사용할 수 없습니다" description="변경된 제공자 설정이나 자격 증명은 없습니다." reference={safeRequestReference(error)} retryHref="/admin/authentication/oidc" />;
  }
}
