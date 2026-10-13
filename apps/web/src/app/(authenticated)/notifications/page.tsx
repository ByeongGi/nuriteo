import { getNotificationPreferences, listNotifications } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../_components/entry-unavailable.tsx";
import { createServerApiClient } from "../../../lib/api/server-client.ts";
import { safeRequestReference } from "../../../lib/api/presentation-error.ts";
import { NotificationCenter } from "./notification-center.tsx";

export const metadata: Metadata = { title: "Notifications" };

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
        title="Notifications are temporarily unavailable"
        description="Your inbox could not be loaded safely. No notification state or email preference was changed."
        reference={safeRequestReference(error)}
        retryHref="/notifications"
      />
    );
  }
}
