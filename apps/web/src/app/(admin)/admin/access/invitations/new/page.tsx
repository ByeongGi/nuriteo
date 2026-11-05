import type { Metadata } from "next";

import { NewActivationInvitation } from "@/app/(admin)/admin/access/invitations/_components/activation-invitations.tsx";

export const metadata: Metadata = { title: "새 사용자 초대" };

export default function NewActivationInvitationPage() {
  return <NewActivationInvitation />;
}
