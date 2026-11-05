import type { Metadata } from "next";

import { loadMfaRoute } from "@/app/(public)/mfa/_utils/load-mfa-route.ts";
import { MfaSecurity } from "@/app/(public)/mfa/_components/security.tsx";
import { EntryUnavailable } from "@/app/_components/entry-unavailable.tsx";

export const metadata: Metadata = {
  description: "인증 앱 또는 복구 코드로 현재 세션을 확인합니다.",
  title: "다단계 인증 확인"
};

export default async function MfaChallengePage() {
  const route = await loadMfaRoute("challenge");
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
  return <MfaSecurity displayName={route.displayName} status={route.status} view="challenge" />;
}
