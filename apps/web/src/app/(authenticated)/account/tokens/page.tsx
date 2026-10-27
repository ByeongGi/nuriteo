import { listAccessTokens } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { AccessTokenConsole } from "#src/app/(authenticated)/account/tokens/token-console.tsx";
import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "개인 액세스 토큰" };

export default async function AccountTokensPage() {
  const target = { kind: "personal" as const };
  try {
    const result = await listAccessTokens(await createServerApiClient(), target);
    return <AccessTokenConsole initialTokens={result.data} target={target} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="개인 액세스 토큰을 일시적으로 사용할 수 없습니다"
        description="자격 증명은 발급·변경·노출되지 않았습니다. 다시 시도하기 전에 계정 상태를 확인하세요."
        reference={safeRequestReference(error)}
        retryHref="/account/tokens"
      />
    );
  }
}

