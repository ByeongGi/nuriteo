import type { Metadata } from "next";

import { NewActivationInvitation } from "#src/app/(admin)/admin/access/invitations/activation-invitations.tsx";

export const metadata: Metadata = { title: "새 사용자 초대" };

export default function NewActivationInvitationPage() {
  return <NewActivationInvitation />;
}
