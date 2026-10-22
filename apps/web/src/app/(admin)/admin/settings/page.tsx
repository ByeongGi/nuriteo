import {
  getAdminStatus,
  listAdminSettings,
  previewAdminPolicyCleanup
} from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { AdminSettings } from "#src/app/(admin)/admin/settings/admin-settings.tsx";

export const metadata: Metadata = { title: "관리자 설정" };

export default async function AdminSettingsPage() {
  try {
    const client = await createServerApiClient();
    const [settings, status, cleanup] = await Promise.all([
      listAdminSettings(client),
      getAdminStatus(client),
      previewAdminPolicyCleanup(client)
    ]);
    const reconciliationKey = settings.data.items
      .map((setting) => `${setting.key}:${setting.version}`)
      .join("|");
    return (
      <AdminSettings
        key={reconciliationKey}
        cleanup={cleanup.data}
        settings={settings.data}
        status={status.data}
      />
    );
  } catch (error) {
    return (
      <EntryUnavailable
        title="관리자 설정을 일시적으로 사용할 수 없습니다"
        description="인스턴스 설정을 안전하게 불러오지 못했습니다. 변경된 설정은 없습니다."
        reference={safeRequestReference(error)}
        retryHref="/admin/settings"
      />
    );
  }
}
