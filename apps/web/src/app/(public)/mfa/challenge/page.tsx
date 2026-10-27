import type { Metadata } from "next";

import { MfaRoute } from "#src/app/(public)/mfa/mfa-route.tsx";

export const metadata: Metadata = {
  description: "인증 앱 또는 복구 코드로 현재 세션을 확인합니다.",
  title: "다단계 인증 확인"
};

export default function MfaChallengePage() {
  return <MfaRoute mode="challenge" />;
}
