import type { Metadata } from "next";

import { MfaRoute } from "#src/app/mfa/mfa-route.tsx";

export const metadata: Metadata = {
  description: "인증 앱을 등록하고 일회용 복구 코드를 안전하게 보관합니다.",
  title: "다단계 인증 설정"
};

export default function MfaSetupPage() {
  return <MfaRoute mode="setup" />;
}
