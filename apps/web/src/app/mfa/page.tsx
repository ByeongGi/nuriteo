import { getCurrentUser, getMfaStatus } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { MfaSecurity } from "#src/app/mfa/security.tsx";

export const metadata: Metadata = { title: "계정 보안" };

export default async function MfaPage() {
  try {
    const client = await createServerApiClient();
    const [current, status] = await Promise.all([
      getCurrentUser(client),
      getMfaStatus(client)
    ]);
    return <MfaSecurity status={status.data} displayName={current.data.user.display_name} />;
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 401) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="보안 설정을 일시적으로 사용할 수 없습니다"
        description="MFA 상태를 안전하게 불러오지 못했습니다. 변경된 자격 증명은 없습니다."
        reference={safeRequestReference(error)}
        retryHref="/mfa"
      />
    );
  }
}

