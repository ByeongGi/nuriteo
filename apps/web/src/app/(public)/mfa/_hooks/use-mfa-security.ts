"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  mfaChallengeCodeSchema,
  mfaEnrollmentCodeSchema,
  mfaRecoveryCodeSchema
} from "@/app/(public)/mfa/_schema/mfa.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { ApiError } from "@/services/http/api.ts";
import {
  beginMfaEnrollment,
  challengeMfa,
  confirmMfaEnrollment,
  disableMfa,
  recoverMfa
} from "@/services/mfa/api.ts";
import { deleteSession } from "@/services/session/api.ts";

import type { MfaEnrollmentStart } from "@nuriteo/api-client";
import type { FormEvent } from "react";

const codeMismatch = "코드가 일치하지 않습니다. 새 코드를 기다리거나 사용하지 않은 복구 코드를 입력하세요.";

export function useMfaSecurity() {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [enrollment, setEnrollment] = useState<MfaEnrollmentStart>();
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>();
  const [copiedRecoveryCodes, setCopiedRecoveryCodes] = useState(false);
  const [message, setMessage] = useState<{ readonly tone: "error" | "success"; readonly text: string }>();
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const idempotencyKeys = useRef(new Map<string, string>());

  function mutationOptions(operation: string) {
    let idempotencyKey = idempotencyKeys.current.get(operation);
    if (idempotencyKey === undefined) {
      idempotencyKey = crypto.randomUUID();
      idempotencyKeys.current.set(operation, idempotencyKey);
    }
    return { csrfToken: readCsrfCredential(), idempotencyKey };
  }

  function settle(operation: string, error?: unknown) {
    if (!(error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN")) {
      idempotencyKeys.current.delete(operation);
    }
  }

  async function begin() {
    await mutation.run(async () => {
      setMessage(undefined);
      const operation = "begin";
      try {
        const result = await beginMfaEnrollment(createBrowserApiClient(), mutationOptions(operation));
        settle(operation);
        setEnrollment(result.data);
      } catch (error) {
        settle(operation, error);
        setMessage(mfaFailure(error));
      }
    });
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enrollment === undefined) return;
    const form = new FormData(event.currentTarget);
    const parsed = mfaEnrollmentCodeSchema.safeParse({ code: String(form.get("code") ?? "") });
    if (!parsed.success) {
      setMessage({ tone: "error", text: parsed.error.issues[0]?.message ?? codeMismatch });
      return;
    }
    const code = parsed.data.code;
    const operation = `confirm:${enrollment.credentialId}:${code}`;
    await mutation.run(async () => {
      try {
        const result = await confirmMfaEnrollment(
          createBrowserApiClient(),
          { credentialId: enrollment.credentialId, code },
          mutationOptions(operation)
        );
        settle(operation);
        setEnrollment(undefined);
        setRecoveryCodes(result.data.recoveryCodes);
        setCopiedRecoveryCodes(false);
        setMessage({ tone: "success", text: "인증 앱을 확인했습니다. 계속하기 전에 모든 복구 코드를 저장하세요." });
      } catch (error) {
        settle(operation, error);
        setMessage(mfaFailure(error));
      }
    });
  }

  async function copyRecoveryCodes() {
    if (recoveryCodes === undefined) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setCopiedRecoveryCodes(true);
      setMessage({ tone: "success", text: "복구 코드를 복사했습니다. 계속하기 전에 안전한 곳에 보관하세요." });
    } catch {
      setMessage({ tone: "error", text: "브라우저가 자동 복사를 허용하지 않았습니다. 코드를 직접 선택해 안전한 곳에 저장한 뒤 아래 확인 항목을 선택하세요." });
    }
  }

  async function finishRecoveryConfirmation() {
    if (!copiedRecoveryCodes) return;
    setRecoveryCodes(undefined);
    router.refresh();
  }

  async function submitCode(event: FormEvent<HTMLFormElement>, recovery: boolean) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = (recovery ? mfaRecoveryCodeSchema : mfaChallengeCodeSchema).safeParse({
      code: String(form.get("code") ?? "")
    });
    if (!parsed.success) {
      setMessage({ tone: "error", text: parsed.error.issues[0]?.message ?? codeMismatch });
      return;
    }
    const code = parsed.data.code;
    const operation = `${recovery ? "recovery" : "challenge"}:${code}`;
    await mutation.run(async () => {
      setMessage(undefined);
      try {
        const client = createBrowserApiClient();
        const options = mutationOptions(operation);
        if (recovery) await recoverMfa(client, code, options);
        else await challengeMfa(client, code, options);
        settle(operation);
        setMessage({
          tone: "success",
          text: recovery
            ? "계정을 복구했습니다. 다른 세션은 로그아웃되었으며 최근 재인증으로 처리되지는 않습니다."
            : "인증 앱 확인을 완료하고 세션을 새로 발급했습니다."
        });
        router.refresh();
      } catch (error) {
        settle(operation, error);
        setMessage(mfaFailure(error));
      }
    });
  }

  async function disable() {
    await mutation.run(async () => {
      try {
        await disableMfa(createBrowserApiClient(), { csrfToken: readCsrfCredential() });
        setConfirmingDisable(false);
        setMessage({ tone: "success", text: "다단계 인증을 해제하고 다른 세션을 로그아웃했습니다." });
        router.refresh();
      } catch (error) {
        setMessage(mfaFailure(error));
      }
    });
  }

  async function signOut() {
    await mutation.run(async () => {
      try {
        await deleteSession(createBrowserApiClient(), { csrfToken: readCsrfCredential() });
        window.location.assign("/sign-in");
      } catch (error) {
        setMessage(mfaFailure(error));
      }
    });
  }

  return {
    begin,
    confirmingDisable,
    confirm,
    copiedRecoveryCodes,
    copyRecoveryCodes,
    disable,
    enrollment,
    finishRecoveryConfirmation,
    isPending: mutation.isPending,
    message,
    recoveryCodes,
    setConfirmingDisable,
    setCopiedRecoveryCodes,
    signOut,
    submitCode
  };
}

function mfaFailure(error: unknown): { readonly tone: "error"; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { tone: "error", text: "서버에 보안 변경이 반영되었을 수 있습니다. 같은 작업을 다시 시도해 보호된 일회성 응답을 복구하세요." };
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { tone: "error", text: "보안을 위해 다시 로그인한 뒤 MFA 변경을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { tone: "error", text: "관리자 정책상 이 MFA 변경을 수행할 수 없습니다." };
  if (error instanceof ApiError && error.status === 401) return { tone: "error", text: "코드가 일치하지 않습니다. 새 코드를 기다리거나 사용하지 않은 복구 코드를 입력하세요." };
  if (error instanceof ApiError && (error.status === 409 || error.status === 412)) return { tone: "error", text: "다른 곳에서 MFA 상태가 변경되었습니다. 새로 고친 뒤 다시 시도하세요." };
  return { tone: "error", text: "보안 변경을 안전하게 완료하지 못했습니다. 노출된 정보는 없으며 잠시 후 다시 시도해 주세요." };
}
