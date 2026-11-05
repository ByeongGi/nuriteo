import { previewAdminPolicyCleanup } from "@/services/admin/api.ts";

import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { StorageCleanupPreview } from "@/app/(admin)/admin/operations/storage-cleanup/_components/cleanup-preview.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "스토리지 정리 점검" };

export default async function StorageCleanupPage() {
  try {
    const preview = await previewAdminPolicyCleanup(await createServerApiClient());
    return <StorageCleanupPreview initial={preview.data} />;
  } catch (error) {
    return <EntryUnavailable title="스토리지 정리 상태를 일시적으로 확인할 수 없습니다" description="정리 후보와 예상 회수량을 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref="/admin/operations/storage-cleanup" />;
  }
}
