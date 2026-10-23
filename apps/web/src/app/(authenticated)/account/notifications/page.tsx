import { getNotificationPreferences } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { NotificationPreferencesForm } from "#src/app/(authenticated)/account/notifications/notification-preferences-form.tsx";
import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "알림 설정" };

export default async function AccountNotificationsPage() {
  try {
    const preferences = await getNotificationPreferences(await createServerApiClient());
    return <NotificationPreferencesForm initialPreferences={preferences.data} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="알림 설정을 일시적으로 사용할 수 없습니다"
        description="현재 수신 설정은 변경하지 않았습니다. 잠시 후 다시 시도하세요."
        reference={safeRequestReference(error)}
        retryHref="/account/notifications"
      />
    );
  }
}
