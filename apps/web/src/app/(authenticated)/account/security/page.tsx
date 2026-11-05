import { getMfaStatus } from "@/services/mfa/api.ts";
import { getCurrentUser } from "@/services/session/api.ts";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { signInHref } from "@/app/(public)/sign-in/_utils/return-to.ts";
import { MfaSecurity } from "@/app/(public)/mfa/_components/security.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "계정 보안" };

export default async function AccountSecurityPage() {
  try {
    const client = await createServerApiClient();
    const [current, status] = await Promise.all([
      getCurrentUser(client),
      getMfaStatus(client)
    ]);
    return <MfaSecurity status={status.data} displayName={current.data.user.display_name} />;
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 401) {
      redirect(signInHref("/account/security"));
    }
    return (
      <EntryUnavailable
        title="보안 설정을 일시적으로 사용할 수 없습니다"
        description="계정 보안 상태를 안전하게 불러오지 못했습니다. 변경된 자격 증명은 없습니다."
        reference={safeRequestReference(error)}
        retryHref="/account/security"
      />
    );
  }
}

