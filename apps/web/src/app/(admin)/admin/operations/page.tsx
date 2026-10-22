import { getAdminOperations } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { OperationsDashboard } from "#src/app/(admin)/admin/operations/operations-dashboard.tsx";

export const metadata: Metadata = { title: "인스턴스 운영" };

export default async function AdminOperationsPage() {
  try {
    const client = await createServerApiClient();
    const operations = await getAdminOperations(client);
    return <OperationsDashboard operations={operations.data} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="운영 상태를 일시적으로 불러올 수 없습니다"
        description="인스턴스 요약을 안전하게 불러오지 못했습니다. 진단 상세 정보는 노출되지 않았습니다."
        reference={safeRequestReference(error)}
        retryHref="/admin/operations"
      />
    );
  }
}
