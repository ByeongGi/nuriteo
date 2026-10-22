import { Suspense } from "react";

import { AcceptInvitation } from "#src/app/(authenticated)/organization-invitations/accept/accept-invitation.tsx";

export default function AcceptOrganizationInvitationPage() {
  return <Suspense fallback={<main id="main-content" className="workspace-page" aria-busy="true">초대를 불러오는 중…</main>}><AcceptInvitation /></Suspense>;
}
