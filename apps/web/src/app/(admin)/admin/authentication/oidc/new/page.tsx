import type { Metadata } from "next";

import { OidcProviderConsole } from "#src/app/(admin)/admin/oidc/provider-console.tsx";

export const metadata: Metadata = { title: "새 OIDC 제공자" };

export default function NewOidcProviderPage() {
  return <OidcProviderConsole createMode initialProviders={[]} />;
}
