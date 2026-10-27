import type { IntegrationCaCollection } from "@nuriteo/api-client";
import Link from "next/link";

import { AdminIntegrationSection, AdminIntegrationSummary } from "#src/app/(admin)/admin/_components/admin-integration-detail.tsx";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminNote, AdminPage } from "#src/app/(admin)/admin/_components/admin-surface.tsx";
import { IntegrationCaConsole } from "#src/app/(admin)/admin/_components/integration-ca-console.tsx";
import { buttonVariants } from "#src/components/ui/button.styles.ts";

export interface SmtpTrustScreenProps {
  readonly initialCollection?: IntegrationCaCollection | undefined;
  readonly smtpConfigured?: boolean;
}

export function SmtpTrustScreen({ initialCollection, smtpConfigured = true }: SmtpTrustScreenProps) {
  const active = initialCollection?.items.find((item) => item.state === "active");
  const candidate = initialCollection?.items.find((item) => item.state === "candidate");
  return (
    <AdminPage id="main-content" contentWidth="standard">
      <AdminPageHeader
        category="연동"
        title="SMTP 인증서 신뢰"
        description="사내 메일 서버가 사설 인증 기관을 사용할 때 TLS 신뢰 체인을 관리합니다. 일반 공개 인증서는 별도 등록이 필요하지 않습니다."
      />
      <AdminIntegrationSummary
        state={active ? "active" : "disabled"}
        title={!smtpConfigured ? "SMTP 연결이 아직 구성되지 않았습니다" : (function () {
    if (active) {
        return ("SMTP 연결에 사용자 인증서를 적용하고 있습니다");
    }
    return ("현재 시스템 인증서 저장소만 사용합니다");
})()}
        description={!smtpConfigured ? "메일 서버 주소와 전송 방식을 먼저 저장하면 해당 연결에 필요한 사설 인증서를 관리할 수 있습니다." : (function () {
    if (active) {
        return ("새 후보를 등록해도 실제 SMTP 사전 점검을 통과하기 전까지 기존 인증서를 계속 사용합니다.");
    }
    return ("사설 CA가 필요한 경우에만 후보를 등록하세요. 검증 전에는 SMTP 연결에 적용되지 않습니다.");
})()}
        metrics={[
          { label: "SMTP 연결", value: smtpConfigured ? "구성됨" : "미설정" },
          { label: "활성 인증서", value: active ? "1개" : "없음" },
          { label: "검증 대기", value: candidate ? "1개" : "없음" },
          { label: "신뢰 기록", value: `${initialCollection?.items.length ?? 0}개` }
        ]}
      />
      {smtpConfigured ? (
        <AdminIntegrationSection title="인증서 신뢰 관리" description="PEM 형식의 CA 후보를 등록하고 실제 SMTP 연결 검증 후 활성화합니다.">
          <IntegrationCaConsole appearance="detail" initialCollection={initialCollection} type="smtp" integrationId="default" />
        </AdminIntegrationSection>
      ) : (
        <AdminIntegrationSection title="SMTP 연결부터 설정하세요" description="인증서 신뢰는 연결할 메일 서버가 정해진 뒤에 구성할 수 있습니다.">
          <div className="grid gap-4">
            <AdminNote>인스턴스 설정에서 SMTP 사용 여부, 서버 주소, 포트, 보안 방식과 발신자 정보를 저장한 뒤 이 화면으로 돌아오세요.</AdminNote>
            <div><Link className={buttonVariants({ variant: "primary" })} href="/admin/system/settings">인스턴스 설정 열기</Link></div>
          </div>
        </AdminIntegrationSection>
      )}
    </AdminPage>
  );
}
