import { getSetupStatus } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { ProductEntryShell } from "#src/app/_components/product-entry-shell.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = {
  title: "인스턴스 설정"
};

const COMPOSE_BOOTSTRAP_COMMAND = "docker compose run --rm bootstrap-admin";

export default async function SetupPage() {
  let bootstrapRequired: boolean;

  try {
    const client = await createServerApiClient();
    const result = await getSetupStatus(client);
    bootstrapRequired = result.data.bootstrapRequired;
  } catch (error) {
    return (
      <EntryUnavailable
        description="부트스트랩 상태를 확인하지 못했습니다. Core 서비스가 정상인지 확인한 뒤 다시 시도하세요."
        reference={safeRequestReference(error)}
        retryHref="/setup"
        title="설정 상태를 확인할 수 없습니다"
      />
    );
  }

  if (!bootstrapRequired) {
    redirect("/sign-in");
  }

  return (
    <ProductEntryShell
      description="보안을 위해 첫 관리자는 서버의 NURITEO 명령줄 도구에서만 생성할 수 있습니다. 이 화면은 부트스트랩 비밀번호를 받거나 표시하지 않습니다."
      eyebrow="관리자 설정"
      title="서버에서 설정을 완료하세요"
      titleId="setup-title"
    >
        <div className="command-panel" aria-labelledby="compose-command-title">
          <h2 id="compose-command-title">Docker Compose</h2>
          <p>호스트에 부트스트랩 보안 파일을 설정한 뒤 다음 명령을 실행하세요.</p>
          <code>{COMPOSE_BOOTSTRAP_COMMAND}</code>
        </div>

        <div className="entry-actions">
          <a className="link-button" href="/">
            설정 상태 다시 확인
          </a>
          <p>설정 상태는 캐시하지 않고 Core에서 직접 확인합니다.</p>
        </div>
    </ProductEntryShell>
  );
}
