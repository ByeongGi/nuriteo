import { listOidcIdentities } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { IdentityConnections } from "#src/app/(authenticated)/identities/identity-connections.tsx";

export const metadata: Metadata = { title: "연결된 계정" };

export default async function IdentitiesPage() {
  try {
    const identities = await listOidcIdentities(await createServerApiClient());
    return <IdentityConnections initialIdentities={identities.data} />;
  } catch (error) {
    return <EntryUnavailable title="연결된 계정을 일시적으로 사용할 수 없습니다" description="계정 연결은 변경하지 않았습니다. 인증 서비스 상태를 확인한 뒤 다시 시도하세요." reference={safeRequestReference(error)} retryHref="/identities" />;
  }
}
