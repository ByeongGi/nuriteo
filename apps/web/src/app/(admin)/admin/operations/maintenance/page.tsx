import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { MaintenanceConsole } from "@/app/(admin)/admin/operations/maintenance/_components/maintenance-console.tsx";
import { getAdminMaintenanceStatus } from "@/app/(admin)/admin/operations/maintenance/_utils/maintenance-model.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "점검 모드" };

export default async function AdminMaintenancePage() {
  try {
    return <MaintenanceConsole initial={await getAdminMaintenanceStatus(await createServerApiClient())} />;
  } catch (error) {
    return <EntryUnavailable title="점검 모드 제어를 일시적으로 사용할 수 없습니다" description="현재 쓰기 허용 상태를 안전하게 확인하지 못했습니다. 변경된 점검 설정은 없습니다." reference={safeRequestReference(error)} retryHref="/admin/operations/maintenance" />;
  }
}
