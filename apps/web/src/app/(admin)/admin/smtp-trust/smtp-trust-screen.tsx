import type { IntegrationCaCollection } from "@nuriteo/api-client";

import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { IntegrationCaConsole } from "#src/app/(admin)/admin/_components/integration-ca-console.tsx";

export interface SmtpTrustScreenProps {
  readonly initialCollection?: IntegrationCaCollection | undefined;
}

export function SmtpTrustScreen({ initialCollection }: SmtpTrustScreenProps) {
  return (
    <main id="main-content" className="workspace-page admin-detail-page">
      <AdminPageHeader
        category="SMTP 인증서"
        title="SMTP 사설 인증서"
        description="사설 CA를 등록하고 TLS, EHLO와 SMTP 인증 검증을 모두 통과한 뒤 활성화하세요."
      />
      <IntegrationCaConsole initialCollection={initialCollection} type="smtp" integrationId="default" />
    </main>
  );
}
