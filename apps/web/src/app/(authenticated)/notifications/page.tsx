import { getNotificationPreferences, listNotifications } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { NotificationCenter } from "#src/app/(authenticated)/notifications/notification-center.tsx";

export const metadata: Metadata = { title: "알림" };

export default async function NotificationsPage() {
  try {
    const client = await createServerApiClient();
    const [active, archived, preferences] = await Promise.all([
      listNotifications(client, { limit: 25 }),
      listNotifications(client, { archived: true, limit: 25 }),
      getNotificationPreferences(client)
    ]);
    return (
      <NotificationCenter
        initialActive={active.data}
        initialArchived={archived.data}
        initialPreferences={preferences.data}
      />
    );
  } catch (error) {
    return (
      <EntryUnavailable
        title="알림을 일시적으로 사용할 수 없습니다"
        description="알림함을 안전하게 불러오지 못했습니다. 알림 상태와 이메일 설정은 변경하지 않았습니다."
        reference={safeRequestReference(error)}
        retryHref="/notifications"
      />
    );
  }
}
