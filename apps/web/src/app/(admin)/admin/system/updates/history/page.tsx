import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { UpdateApprovalHistory } from "#src/app/(admin)/admin/updates/update-readiness-console.tsx";
import { getAdminUpdateHistory } from "#src/app/(admin)/admin/updates/update-model.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "업데이트 승인 이력" };

export default async function UpdateApprovalHistoryPage() {
  try {
    const history = await getAdminUpdateHistory(await createServerApiClient(), { limit: 25 });
    return <UpdateApprovalHistory history={history} />;
  } catch (error) {
    return <EntryUnavailable title="승인 이력을 일시적으로 불러올 수 없습니다" description="업데이트 승인 기록을 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref="/admin/system/updates/history" />;
  }
}
