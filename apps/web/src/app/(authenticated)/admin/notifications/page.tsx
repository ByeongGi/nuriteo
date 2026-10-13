import { getCurrentUser, listEmailDeliveries } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { EmailDeliveryConsole } from "./email-delivery-console.tsx";

export const metadata: Metadata = { title: "Email delivery" };

export default async function AdminNotificationsPage() {
  try {
    const client = await createServerApiClient();
    const [current, deliveries] = await Promise.all([
      getCurrentUser(client),
      listEmailDeliveries(client, { state: "dead_letter", limit: 25 })
    ]);
    if (!current.data.user.is_instance_admin) {
      return <main id="main-content" className="workspace-page"><h1>Administrator access required</h1></main>;
    }
    return <EmailDeliveryConsole initial={deliveries.data} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="Email delivery is temporarily unavailable"
        description="Delivery state could not be inspected safely. No retry or discard was attempted."
        reference={safeRequestReference(error)}
        retryHref="/admin/notifications"
      />
    );
  }
}
