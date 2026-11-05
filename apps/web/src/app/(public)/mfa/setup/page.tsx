import type { Metadata } from "next";

import { loadMfaRoute } from "@/app/(public)/mfa/_utils/load-mfa-route.ts";
import { MfaSecurity } from "@/app/(public)/mfa/_components/security.tsx";
import { EntryUnavailable } from "@/app/_components/entry-unavailable.tsx";

export const metadata: Metadata = {
  description: "인증 앱을 등록하고 일회용 복구 코드를 안전하게 보관합니다.",
  title: "다단계 인증 설정"
};

export default async function MfaSetupPage() {
  const route = await loadMfaRoute("setup");
  if (route.kind === "unavailable") {
    return (
      <EntryUnavailable
        description={route.description}
        reference={route.reference}
        retryHref={route.retryHref}
        title={route.title}
      />
    );
  }
  return <MfaSecurity displayName={route.displayName} status={route.status} view="setup" />;
}
