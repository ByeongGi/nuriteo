"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { parseSettingDraft } from "@/app/(admin)/admin/system/settings/_schema/admin-setting.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { previewAdminPolicyChange, updateAdminSetting } from "@/services/admin/api.ts";
import { ApiError } from "@/services/http/api.ts";

import type { ChangeEvent, FormEvent } from "react";
import type { AdminPolicyImpact, AdminSetting, AdminSettingValue, AdminStatus } from "@nuriteo/api-client";

interface SettingDescriptor {
  readonly label: string;
  readonly description: string;
  readonly unit?: string;
}

export function useAdminSettings(status: AdminStatus) {
  const [restartRequired, setRestartRequired] = useState(status.restartRequired);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");

  return {
    category,
    onCategory: setCategory,
    onQueryChange: (event: ChangeEvent<HTMLInputElement>) => setQuery(event.currentTarget.value),
    onRestartRequired: () => setRestartRequired(true),
    query,
    restartRequired
  };
}

export function useSettingEditor({
  descriptor,
  initial,
  onRestartRequired
}: {
  readonly descriptor: SettingDescriptor;
  readonly initial: AdminSetting;
  readonly onRestartRequired: () => void;
}) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [setting, setSetting] = useState(initial);
  const [draft, setDraft] = useState(settingValueToDraft(initial.value));
  const [unlimited, setUnlimited] = useState(initial.value === null);
  const [impact, setImpact] = useState<{ readonly signature: string; readonly value: AdminPolicyImpact }>();
  const [feedback, setFeedback] = useState<{ message: string; reconcile: boolean; tone: "error" | "success" }>();

  async function preview(value: AdminSettingValue) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await previewAdminPolicyChange(
          createBrowserApiClient(),
          setting.key,
          value,
          { csrfToken: readCsrfCredential() }
        );
        setImpact({ signature: valueSignature(value), value: result.data });
      } catch (error) {
        setImpact(undefined);
        setFeedback(settingFailure(error));
      }
    });
  }

  async function review() {
    try {
      await preview(parseSettingDraft(setting.constraint, draft, unlimited));
    } catch (error) {
      setFeedback(settingFailure(error));
    }
  }

  async function resetDefault() {
    const value = setting.defaultValue;
    setDraft(settingValueToDraft(value));
    setUnlimited(value === null);
    setImpact(undefined);
    await preview(value);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const value = parseSettingDraft(setting.constraint, draft, unlimited);
        if (impact?.signature !== valueSignature(value)) {
          setFeedback({
            message: "변경을 적용하기 전에 현재 값의 영향을 검토해 주세요.",
            reconcile: false,
            tone: "error"
          });
          return;
        }
        const result = await updateAdminSetting(
          createBrowserApiClient(),
          { key: setting.key, value, version: setting.version },
          { csrfToken: readCsrfCredential() }
        );
        setSetting(result.data);
        setDraft(settingValueToDraft(result.data.value));
        setUnlimited(result.data.value === null);
        setImpact(undefined);
        if (result.data.applyMode === "server_restart") onRestartRequired();
        setFeedback({ message: `${descriptor.label} 설정을 저장했습니다.`, reconcile: false, tone: "success" });
      } catch (error) {
        setFeedback(settingFailure(error));
      }
    });
  }

  return {
    draft,
    feedback,
    impact,
    mutation,
    onDraft: (value: string) => { setDraft(value); setImpact(undefined); setFeedback(undefined); },
    onUnlimited: (value: boolean) => { setUnlimited(value); setImpact(undefined); setFeedback(undefined); },
    refresh: () => router.refresh(),
    resetDefault,
    review,
    setting,
    submit,
    unlimited
  };
}

export function settingValueToDraft(value: AdminSettingValue): string {
  return value === null ? "" : String(value);
}

function valueSignature(value: AdminSettingValue): string {
  return JSON.stringify(value);
}

function settingFailure(error: unknown): { message: string; reconcile: boolean; tone: "error" } {
  if (error instanceof ApiError) {
    if (error.status === 412 || error.status === 428) {
      return {
        message: "다른 곳에서 설정이 변경되었습니다. 최신 상태를 불러온 뒤 다시 저장해 주세요.",
        reconcile: true,
        tone: "error"
      };
    }
    if (error.code === "REAUTHENTICATION_REQUIRED") {
      return {
        message: "보안을 위해 다시 로그인한 뒤 설정 변경을 다시 시도하세요.",
        reconcile: false,
        tone: "error"
      };
    }
    if (error.status === 403) {
      return {
        message: "이 설정을 변경할 관리자 권한이 없습니다.",
        reconcile: false,
        tone: "error"
      };
    }
    if (error.status === 400 || error.status === 422) {
      return {
        message: "서버 정책에서 허용하지 않는 값입니다. 값을 확인한 뒤 다시 시도해 주세요.",
        reconcile: false,
        tone: "error"
      };
    }
  }
  return {
    message: error instanceof TypeError
      ? error.message
      : "설정을 안전하게 저장하지 못했습니다. 변경 사항은 확정되지 않았습니다.",
    reconcile: false,
    tone: "error"
  };
}
