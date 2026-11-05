import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { parseAuditEventCollection } from "@/app/(admin)/admin/system/audit-log/_utils/audit-log-model.ts";
import { AuditLogTable } from "@/app/(admin)/admin/system/audit-log/_components/audit-log-table.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "감사 로그" };

export default async function AdminAuditLogPage() {
  try {
    const response = await (await createServerApiClient()).get<unknown>("/admin/audit-events?limit=25");
    return <AuditLogTable initialPage={parseAuditEventCollection(response.data)} />;
  } catch (error) {
    return <EntryUnavailable title="감사 로그를 일시적으로 불러올 수 없습니다" description="감사 이벤트를 안전하게 조회하지 못했습니다. 변경되거나 삭제된 기록은 없습니다." reference={safeRequestReference(error)} retryHref="/admin/system/audit-log" />;
  }
}
