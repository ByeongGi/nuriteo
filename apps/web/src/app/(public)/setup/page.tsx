import { getSetupStatus } from "@/services/setup/api.ts";

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { tv } from "tailwind-variants";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { ProductEntryShell } from "#src/app/_components/product-entry-shell.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = {
  title: "인스턴스 설정"
};

const COMPOSE_BOOTSTRAP_COMMAND = "docker compose run --rm bootstrap-admin";

const setupStyles = tv({
  slots: {
    command: "mt-6 grid gap-3 rounded-xl border border-muted-border bg-subtle p-4 [&_h2]:m-0 [&_h2]:text-base [&_p]:m-0 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-muted-foreground [&_code]:overflow-x-auto [&_code]:rounded-md [&_code]:border [&_code]:border-muted-border [&_code]:bg-raised [&_code]:p-3 [&_code]:text-sm",
    actions: "mt-5 grid gap-3 border-t border-muted-border pt-5 [&_p]:m-0 [&_p]:text-xs [&_p]:text-muted-foreground",
    retry: "inline-flex min-h-10 w-fit items-center justify-center rounded-md border border-primary bg-primary px-4 text-sm font-medium text-on-primary no-underline shadow-xs hover:bg-primary-strong"
  }
});

export default async function SetupPage() {
  const styles = setupStyles();
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
        <div className={styles.command()} aria-labelledby="compose-command-title">
          <h2 id="compose-command-title">Docker Compose</h2>
          <p>호스트에 부트스트랩 보안 파일을 설정한 뒤 다음 명령을 실행하세요.</p>
          <code>{COMPOSE_BOOTSTRAP_COMMAND}</code>
        </div>

        <div className={styles.actions()}>
          <a className={styles.retry()} href="/">
            설정 상태 다시 확인
          </a>
          <p>설정 상태는 캐시하지 않고 Core에서 직접 확인합니다.</p>
        </div>
    </ProductEntryShell>
  );
}
