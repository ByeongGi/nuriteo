"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { mfaPolicyDraftSchema, mfaResetSearchSchema } from "@/app/(admin)/admin/_schema/mfa-policy.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { ApiError } from "@/services/http/api.ts";
import { previewMfaPolicy, resetUserMfa, searchMfaResetTargets, updateMfaPolicy } from "@/services/mfa/api.ts";

import type { FormEvent } from "react";
import type { MfaPolicy, MfaPolicyImpact, MfaPolicyMode, MfaResetTarget } from "@nuriteo/api-client";

export function useMfaPolicyEditor(initial: MfaPolicy) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [policy, setPolicy] = useState(initial);
  const [mode, setMode] = useState<MfaPolicyMode>(initial.mode);
  const [graceDays, setGraceDays] = useState(initial.gracePeriodDays);
  const [impact, setImpact] = useState<MfaPolicyImpact>();
  const [targets, setTargets] = useState<readonly MfaResetTarget[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<MfaResetTarget>();
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly tone: "error" | "success"; readonly text: string; readonly reconcile?: boolean }>();
  const previewIsCurrent = impact?.mode === mode && impact.gracePeriodDays === graceDays && impact.policyVersion === policy.version;

  function changeMode(nextMode: MfaPolicyMode) {
    setMode(nextMode);
    setImpact(undefined);
  }

  function changeGraceDays(nextValue: number | null) {
    if (nextValue !== null) setGraceDays(nextValue);
    setImpact(undefined);
  }

  function selectTarget(credentialGeneration: string) {
    setSelectedTarget(targets.find((target) => target.credentialGeneration === credentialGeneration));
    setResetConfirmed(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = mfaPolicyDraftSchema.safeParse({ mode, gracePeriodDays: graceDays });
    if (!parsed.success) {
      setFeedback({ tone: "error", text: parsed.error.issues[0]?.message ?? "변경을 안전하게 반영하지 못했습니다. 기존 정책은 그대로 유지됩니다." });
      return;
    }
    if (!previewIsCurrent || impact === undefined) return;
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await updateMfaPolicy(
          createBrowserApiClient(),
          {
            mode: parsed.data.mode,
            gracePeriodDays: parsed.data.gracePeriodDays,
            version: policy.version,
            populationProof: impact.populationProof
          },
          { csrfToken: readCsrfCredential() }
        );
        setPolicy(result.data);
        setImpact(undefined);
        setFeedback({ tone: "success", text: "MFA 정책과 등록 기한을 조정했습니다." });
      } catch (error) {
        setImpact(undefined);
        setFeedback(policyFailure(error));
      }
    });
  }

  async function preview() {
    const parsed = mfaPolicyDraftSchema.safeParse({ mode, gracePeriodDays: graceDays });
    if (!parsed.success) {
      setFeedback({ tone: "error", text: parsed.error.issues[0]?.message ?? "변경을 안전하게 반영하지 못했습니다. 기존 정책은 그대로 유지됩니다." });
      return;
    }
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await previewMfaPolicy(
          createBrowserApiClient(),
          { mode: parsed.data.mode, gracePeriodDays: parsed.data.gracePeriodDays, version: policy.version },
          { csrfToken: readCsrfCredential() }
        );
        setImpact(result.data);
      } catch (error) {
        setImpact(undefined);
        setFeedback(policyFailure(error));
      }
    });
  }

  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTarget || !resetConfirmed) return;
    await mutation.run(async () => {
      try {
        await resetUserMfa(createBrowserApiClient(), selectedTarget, { csrfToken: readCsrfCredential() });
        setTargets([]);
        setSelectedTarget(undefined);
        setResetConfirmed(false);
        setFeedback({ tone: "success", text: "대상 사용자의 MFA 자격 증명과 세션을 초기화했습니다." });
      } catch (error) {
        setFeedback(policyFailure(error));
      }
    });
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = mfaResetSearchSchema.safeParse({ query: String(new FormData(event.currentTarget).get("query") ?? "") });
    if (!parsed.success) {
      setFeedback({ tone: "error", text: parsed.error.issues[0]?.message ?? "이메일 또는 표시 이름으로 찾기" });
      return;
    }
    await mutation.run(async () => {
      try {
        const result = await searchMfaResetTargets(createBrowserApiClient(), parsed.data.query);
        setTargets(result.data);
        setSelectedTarget(undefined);
        setResetConfirmed(false);
        setFeedback(result.data.length === 0 ? { tone: "error", text: "검색 조건에 맞는 활성 로컬 MFA 사용자가 없습니다." } : undefined);
      } catch (error) {
        setFeedback(policyFailure(error));
      }
    });
  }

  return {
    changeGraceDays,
    changeMode,
    feedback,
    graceDays,
    impact,
    mode,
    mutation,
    policy,
    preview,
    previewIsCurrent,
    refresh: () => router.refresh(),
    reset,
    resetConfirmed,
    save,
    search,
    selectTarget,
    selectedTarget,
    setResetConfirmed,
    targets
  };
}

function policyFailure(error: unknown): { readonly tone: "error"; readonly text: string; readonly reconcile?: boolean } {
  if (error instanceof ApiError && (error.status === 412 || error.status === 428)) return { tone: "error", text: "정책 상태가 변경되었거나 활성 로컬 관리자 안전 조건을 충족하지 못했습니다. 새로 고친 뒤 영향을 다시 검토하세요.", reconcile: true };
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { tone: "error", text: "보안을 위해 다시 로그인한 뒤 MFA 정책 변경을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { tone: "error", text: "이 MFA 정책을 변경할 관리자 권한이 없습니다." };
  return { tone: "error", text: "변경을 안전하게 반영하지 못했습니다. 기존 정책은 그대로 유지됩니다." };
}
