import { listActivationInvitations } from "@/services/activation/api.ts";

import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { ActivationInvitations } from "@/app/(admin)/admin/access/invitations/_components/activation-invitations.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "사용자 초대" };

export default async function ActivationInvitationsPage() {
  try {
    const invitations = await listActivationInvitations(await createServerApiClient(), { limit: 25 });
    return <ActivationInvitations initial={invitations.data} />;
  } catch (error) {
    return <EntryUnavailable title="초대를 일시적으로 불러올 수 없습니다" description="초대 목록을 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref="/admin/access/invitations" />;
  }
}
