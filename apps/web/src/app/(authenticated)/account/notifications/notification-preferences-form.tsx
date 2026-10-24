"use client";

import { ApiError, updateNotificationPreferences } from "@nuriteo/api-client";
import type { NotificationPreferences } from "@nuriteo/api-client";
import { useState } from "react";
import type { FormEvent } from "react";
import { tv } from "tailwind-variants";

import { Button } from "#src/components/ui/button.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { SettingsGroup, SettingsRow } from "#src/components/ui/settings-group.tsx";
import { SwitchField } from "#src/components/ui/switch.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

const notificationPreferencesStyles = tv({
  slots: {
    root: "grid gap-4 outline-none",
    channel: "grid gap-1",
    channelTitle: "m-0 text-base font-semibold",
    channelDescription: "m-0 text-sm leading-relaxed text-muted-foreground",
    form: "grid gap-3",
    actions: "flex justify-end border-t border-muted-border pt-4 max-[30rem]:[&>[data-slot=button]]:w-full",
    feedback: "m-0 rounded-md border border-muted-border bg-raised px-4 py-3 text-sm",
    error: "border-danger/40 text-danger"
  }
});

export function NotificationPreferencesForm({ initialPreferences }: Readonly<{
  initialPreferences: NotificationPreferences;
}>) {
  const mutation = useExclusiveMutation();
  const [preferences, setPreferences] = useState(initialPreferences);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const styles = notificationPreferencesStyles();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await updateNotificationPreferences(
          createBrowserApiClient(),
          {
            accountAccess: data.get("accountAccess") === "on",
            collaboration: data.get("collaboration") === "on",
            operations: data.get("operations") === "on",
            version: preferences.version
          },
          { csrfToken: readCsrfCredential() }
        );
        setPreferences(result.data);
        setFeedback({ error: false, text: "알림 설정을 저장했습니다." });
      } catch (error) {
        setFeedback(preferenceFailure(error));
      }
    });
  }

  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader
        density="compact"
        eyebrow="계정"
        title="알림 설정"
        description="알림함과 분리해 이벤트별 이메일 수신 방식을 관리합니다."
      />
      {feedback ? (
        <p className={styles.feedback({ className: feedback.error ? styles.error() : undefined })} role={feedback.error ? "alert" : "status"}>
          {feedback.text}
        </p>
      ) : null}
      <form className={styles.form()} onSubmit={save} aria-busy={mutation.isPending}>
        <SettingsGroup
          density="compact"
          title="이메일 채널"
          description={preferences.smtpConfigured
            ? "이벤트별 이메일 수신 여부를 선택합니다."
            : "SMTP가 설정되지 않았습니다. 선택은 저장되며 앱 내 알림은 계속 사용할 수 있습니다."}
        >
          <SettingsRow density="compact" title="중요 보안" description="로그인과 계정 보호에 필요한 필수 알림입니다."><SwitchField density="compact" name="criticalSecurity" label="항상 받기" defaultChecked disabled /></SettingsRow>
          <SettingsRow density="compact" title="계정과 접근" description="비밀번호, MFA, 멤버십 및 권한 변경"><SwitchField density="compact" name="accountAccess" label="이메일 받기" defaultChecked={preferences.accountAccess} /></SettingsRow>
          <SettingsRow density="compact" title="협업" description="초대와 공유 프로젝트 활동"><SwitchField density="compact" name="collaboration" label="이메일 받기" defaultChecked={preferences.collaboration} /></SettingsRow>
          <SettingsRow density="compact" title="운영" description="관리자를 위한 인스턴스 상태와 전달 장애"><SwitchField density="compact" name="operations" label="이메일 받기" defaultChecked={preferences.operations} /></SettingsRow>
        </SettingsGroup>
        <div className={styles.actions()}><Button type="submit" size="sm" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "저장 중…" : "변경 사항 저장"}</Button></div>
      </form>
    </main>
  );
}

function preferenceFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") {
    return { error: true, text: "저장이 완료됐을 수 있습니다. 다시 시도하기 전에 최신 상태를 확인하세요." };
  }
  if (error instanceof ApiError && (error.status === 412 || error.status === 428)) {
    return { error: true, text: "다른 곳에서 설정이 변경됐습니다. 페이지를 새로고침해 최신 상태를 확인하세요." };
  }
  return { error: true, text: "알림 설정을 저장하지 못했습니다. 기존 설정은 유지됩니다." };
}

