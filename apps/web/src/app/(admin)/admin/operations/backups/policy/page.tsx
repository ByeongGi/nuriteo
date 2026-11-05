import { getAdminBackups } from "@/services/admin/api.ts";

import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { BackupConsole } from "@/app/(admin)/admin/operations/backups/_components/backup-console.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "백업 정책" };

export default async function BackupPolicyPage() {
  try {
    const backups = await getAdminBackups(await createServerApiClient());
    return <BackupConsole initial={backups.data} view="policy" />;
  } catch (error) {
    return <EntryUnavailable title="백업 정책을 일시적으로 사용할 수 없습니다" description="현재 백업 설정을 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref="/admin/operations/backups/policy" />;
  }
}
