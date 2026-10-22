import { listEmailDeliveries } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { EmailDeliveryConsole } from "#src/app/(admin)/admin/notifications/email-delivery-console.tsx";

export const metadata: Metadata = { title: "이메일 전송" };

export default async function AdminNotificationsPage() {
  try {
    const client = await createServerApiClient();
    const deliveries = await listEmailDeliveries(client, { state: "dead_letter", limit: 25 });
    return <EmailDeliveryConsole initial={deliveries.data} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="이메일 전송 상태를 일시적으로 불러올 수 없습니다"
        description="전송 상태를 안전하게 확인하지 못했습니다. 재시도하거나 폐기한 항목은 없습니다."
        reference={safeRequestReference(error)}
        retryHref="/admin/notifications"
      />
    );
  }
}
