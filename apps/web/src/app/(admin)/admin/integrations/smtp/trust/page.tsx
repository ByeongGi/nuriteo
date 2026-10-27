import { ApiError, listIntegrationCas } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { SmtpTrustScreen } from "#src/app/(admin)/admin/integrations/smtp/trust/smtp-trust-screen.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "SMTP 인증서 신뢰" };

export default async function SmtpTrustPage() {
  try {
    const collection = await listIntegrationCas(await createServerApiClient(), "smtp", "default");
    return <SmtpTrustScreen initialCollection={collection.data} />;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return <SmtpTrustScreen smtpConfigured={false} />;
    }
    return <EntryUnavailable title="SMTP 인증서 정보를 불러올 수 없습니다" description="기존 인증서 신뢰 설정은 변경되지 않았습니다." reference={safeRequestReference(error)} retryHref="/admin/integrations/smtp/trust" />;
  }
}
