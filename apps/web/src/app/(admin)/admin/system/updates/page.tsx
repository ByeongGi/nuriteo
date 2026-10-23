import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { UpdateReadinessConsole } from "#src/app/(admin)/admin/updates/update-readiness-console.tsx";
import { getAdminUpdateHistory, getAdminUpdateReadiness } from "#src/app/(admin)/admin/updates/update-model.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "업데이트 준비 상태" };

export default async function AdminUpdatesPage() {
  try {
    const client = await createServerApiClient();
    const [readiness, history] = await Promise.all([getAdminUpdateReadiness(client), getAdminUpdateHistory(client)]);
    return <UpdateReadinessConsole readiness={readiness} history={history} />;
  } catch (error) {
    return <EntryUnavailable title="업데이트 준비 상태를 일시적으로 불러올 수 없습니다" description="호환성과 사전 점검 상태를 안전하게 불러오지 못했습니다. 승인되거나 시작된 업데이트는 없습니다." reference={safeRequestReference(error)} retryHref="/admin/system/updates" />;
  }
}
