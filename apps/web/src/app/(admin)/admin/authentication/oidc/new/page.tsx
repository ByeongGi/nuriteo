import type { Metadata } from "next";

import { OidcProviderConsole } from "@/app/(admin)/admin/authentication/oidc/_components/provider-console.tsx";

export const metadata: Metadata = { title: "새 OIDC 제공자" };

export default function NewOidcProviderPage() {
  return <OidcProviderConsole createMode initialProviders={[]} />;
}
