import { getMfaPolicy } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { MfaPolicyEditor } from "#src/app/(admin)/admin/mfa/policy-editor.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "사용자 MFA 초기화" };

export default async function AdminMfaResetPage() {
  try {
    const policy = await getMfaPolicy(await createServerApiClient());
    return <MfaPolicyEditor key={policy.data.version} initial={policy.data} view="reset" />;
  } catch (error) {
    return <EntryUnavailable title="사용자 MFA 초기화를 일시적으로 사용할 수 없습니다" description="사용자 접근 복구 도구를 안전하게 불러오지 못했습니다. 변경된 계정은 없습니다." reference={safeRequestReference(error)} retryHref="/admin/access/mfa-reset" />;
  }
}
