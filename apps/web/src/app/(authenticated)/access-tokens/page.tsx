import { listAccessTokens } from "@nuriteo/api-client";
import type { AccessTokenTarget } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { AccessTokenConsole } from "#src/app/(authenticated)/access-tokens/token-console.tsx";

export const metadata: Metadata = { title: "액세스 토큰" };

export default async function AccessTokensPage({
  searchParams
}: {
  readonly searchParams: Promise<{ readonly projectId?: string }>;
}) {
  const projectId = (await searchParams).projectId;
  const target: AccessTokenTarget = projectId === undefined
    ? { kind: "personal" }
    : { kind: "project", projectId };
  try {
    const result = await listAccessTokens(await createServerApiClient(), target);
    return <AccessTokenConsole initialTokens={result.data} target={target} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="액세스 토큰을 일시적으로 사용할 수 없습니다"
        description="자격 증명은 발급·변경·노출되지 않았습니다. 프로젝트 식별자와 관리 권한을 확인한 뒤 다시 시도하세요."
        reference={safeRequestReference(error)}
        retryHref="/access-tokens"
      />
    );
  }
}
