import type { Metadata } from "next";

import { SmtpTrustScreen } from "#src/app/(admin)/admin/smtp-trust/smtp-trust-screen.tsx";

export const metadata: Metadata = { title: "SMTP 인증서 신뢰" };

export default function SmtpTrustPage() {
  return <SmtpTrustScreen />;
}
