"use client";

import { useState } from "react";

import { notificationPreferencesSchema } from "@/app/(authenticated)/account/notifications/_schema/notification-preferences.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { ApiError } from "@/services/http/api.ts";
import { updateNotificationPreferences } from "@/services/notifications/api.ts";

import type { NotificationPreferences } from "@nuriteo/api-client";
import type { FormEvent } from "react";

export function useNotificationPreferencesForm(initialPreferences: NotificationPreferences) {
  const mutation = useExclusiveMutation();
  const [preferences, setPreferences] = useState(initialPreferences);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = notificationPreferencesSchema.safeParse({
      accountAccess: data.get("accountAccess") === "on",
      collaboration: data.get("collaboration") === "on",
      operations: data.get("operations") === "on",
      version: preferences.version
    });
    if (!parsed.success) {
      setFeedback({
        error: true,
        text: parsed.error.issues[0]?.message ?? "알림 설정을 저장하지 못했습니다. 기존 설정은 유지됩니다."
      });
      return;
    }
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await updateNotificationPreferences(
          createBrowserApiClient(),
          parsed.data,
          { csrfToken: readCsrfCredential() }
        );
        setPreferences(result.data);
        setFeedback({ error: false, text: "알림 설정을 저장했습니다." });
      } catch (error) {
        setFeedback(preferenceFailure(error));
      }
    });
  }

  return {
    feedback,
    isPending: mutation.isPending,
    preferences,
    save
  };
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
