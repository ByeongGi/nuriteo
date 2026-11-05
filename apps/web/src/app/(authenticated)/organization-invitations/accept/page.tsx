import { Suspense } from "react";

import { AcceptInvitation } from "@/app/(authenticated)/organization-invitations/accept/_components/accept-invitation.tsx";
import { ProductEntryLoading } from "#src/app/_components/product-entry-shell.tsx";

export default function AcceptOrganizationInvitationPage() {
  return <Suspense fallback={<ProductEntryLoading compact label="워크스페이스 초대를 불러오는 중" />}><AcceptInvitation /></Suspense>;
}
