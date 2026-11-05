"use client";

import type { NotificationPreferences } from "@nuriteo/api-client";
import { tv } from "tailwind-variants";

import { useNotificationPreferencesForm } from "@/app/(authenticated)/account/notifications/_hooks/use-notification-preferences-form.ts";
import { Button } from "@/components/ui/button.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SettingsGroup, SettingsRow } from "@/components/ui/settings-group.tsx";
import { SwitchField } from "@/components/ui/switch.tsx";

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
  const { feedback, isPending, preferences, save } = useNotificationPreferencesForm(initialPreferences);
  const styles = notificationPreferencesStyles();

  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader
        density="compact"
        eyebrow="계정"
        title="알림 설정"
        description="알림함과 분리해 이벤트별 이메일 수신 방식을 관리합니다."
      />
      {feedback ? (
        <p className={styles.feedback({ className: (function () {
    if (feedback.error) {
        return (styles.error());
    }
    return (undefined);
})() })} role={(function () {
    if (feedback.error) {
        return ("alert");
    }
    return ("status");
})()}>
          {feedback.text}
        </p>
      ) : null}
      <form className={styles.form()} onSubmit={save} aria-busy={isPending}>
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
        <div className={styles.actions()}><Button type="submit" size="sm" variant="primary" disabled={isPending}>{isPending ? "저장 중…" : "변경 사항 저장"}</Button></div>
      </form>
    </main>
  );
}

