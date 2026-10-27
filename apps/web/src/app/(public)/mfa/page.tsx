import { getMfaStatus } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { signInHref } from "#src/app/(public)/sign-in/return-to.ts";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "계정 보안" };

export default async function LegacyMfaPage() {
  let status: Awaited<ReturnType<typeof getMfaStatus>>;
  try {
    status = await getMfaStatus(await createServerApiClient());
  } catch (error) {
    if (isExplicitlySignedOut(error)) redirect(signInHref("/mfa"));
    return (
      <EntryUnavailable
        title="보안 설정을 일시적으로 사용할 수 없습니다"
        description="MFA 상태를 안전하게 불러오지 못했습니다. 변경된 자격 증명은 없습니다."
        reference={safeRequestReference(error)}
        retryHref="/mfa"
      />
    );
  }

  redirect(status.data.localAccount && !status.data.enrolled ? "/mfa/setup" : "/mfa/challenge");
}

