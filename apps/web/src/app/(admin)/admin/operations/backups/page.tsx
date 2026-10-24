import { getAdminBackups, listAdminBackupOperations } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { BackupConsole } from "#src/app/(admin)/admin/backups/backup-console.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "백업" };

export default async function AdminBackupsPage() {
  try {
    const client = await createServerApiClient();
    const [backups, operations] = await Promise.all([
      getAdminBackups(client),
      listAdminBackupOperations(client, { limit: 25 })
    ]);
    return <BackupConsole initial={backups.data} initialOperations={operations.data} />;
  } catch (error) {
    return <EntryUnavailable title="백업 제어를 일시적으로 사용할 수 없습니다" description="복원 지점과 정책 상태를 안전하게 확인하지 못했습니다. 변경된 백업 설정은 없습니다." reference={safeRequestReference(error)} retryHref="/admin/operations/backups" />;
  }
}
