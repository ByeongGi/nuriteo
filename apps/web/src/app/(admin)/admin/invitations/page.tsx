import { listActivationInvitations } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { ActivationInvitations } from "#src/app/(admin)/admin/invitations/activation-invitations.tsx";

export const metadata: Metadata = { title: "계정 활성화 초대" };

export default async function ActivationInvitationsPage() {
  try {
    const client = await createServerApiClient();
    const invitations = await listActivationInvitations(client);
    return <ActivationInvitations invitations={invitations.data.items} />;
  } catch (error) {
    return <EntryUnavailable title="초대를 일시적으로 불러올 수 없습니다" description="초대 목록을 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref="/admin/invitations" />;
  }
}
