import { Suspense } from "react";

import { AcceptInvitation } from "./accept-invitation.tsx";

export default function AcceptOrganizationInvitationPage() {
  return <Suspense fallback={<main id="main-content" className="workspace-page" aria-busy="true">Loading invitation…</main>}><AcceptInvitation /></Suspense>;
}
