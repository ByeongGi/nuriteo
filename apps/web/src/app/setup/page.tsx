import { getSetupStatus } from "@nuriteo/api-client";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "../_components/entry-unavailable.tsx";
import { ProductEntryShell } from "../_components/product-entry-shell.tsx";
import { createServerApiClient } from "../../lib/api/server-client.ts";
import { safeRequestReference } from "../../lib/api/presentation-error.ts";

export const metadata: Metadata = {
  title: "Set up this instance"
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
        description="NURITEO could not check the bootstrap state. Retry after confirming that the Core service is healthy."
        reference={safeRequestReference(error)}
        retryHref="/setup"
        title="Setup status is unavailable"
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
          <p>Configure the bootstrap secret files on the host, then run:</p>
          <code>{COMPOSE_BOOTSTRAP_COMMAND}</code>
        </div>

        <div className="entry-actions">
          <Link className="link-button" href="/">
            Check setup status
          </Link>
          <p>The check is made directly against Core and is never cached.</p>
        </div>
    </ProductEntryShell>
  );
}
