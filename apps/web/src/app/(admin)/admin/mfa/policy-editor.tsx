"use client";

import { ApiError, previewMfaPolicy, resetUserMfa, searchMfaResetTargets, updateMfaPolicy } from "@nuriteo/api-client";
import type { MfaPolicy, MfaPolicyImpact, MfaPolicyMode, MfaResetTarget } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Badge } from "#src/components/ui/badge.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { RadioCardGroup } from "#src/components/ui/radio-group.tsx";
import { TextField } from "#src/components/ui/field.tsx";
import { NumberField } from "#src/components/ui/number-field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminForm, AdminFormActionNote, AdminFormActions, AdminFormFieldSpan, AdminFormSection } from "#src/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminPage, AdminSectionHeading } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

const POLICY_OPTIONS: readonly { readonly value: MfaPolicyMode; readonly label: string; readonly description: string }[] = [
  { value: "off", label: "선택", description: "사용자가 MFA 사용 여부를 선택합니다." },
  { value: "administrators", label: "관리자", description: "활성 로컬 인스턴스 관리자에게 요구합니다." },
  { value: "all_local_users", label: "모든 로컬 사용자", description: "로컬 비밀번호를 가진 모든 활성 계정에 요구합니다." }
];

export function MfaPolicyEditor({ initial, view = "policy" }: { readonly initial: MfaPolicy; readonly view?: "policy" | "reset" }) {
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

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!previewIsCurrent || impact === undefined) return;
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await updateMfaPolicy(
          createBrowserApiClient(),
          {
            mode,
            gracePeriodDays: graceDays,
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
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await previewMfaPolicy(
          createBrowserApiClient(),
          { mode, gracePeriodDays: graceDays, version: policy.version },
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
    const query = String(new FormData(event.currentTarget).get("query") ?? "");
    await mutation.run(async () => {
      try {
        const result = await searchMfaResetTargets(createBrowserApiClient(), query);
        setTargets(result.data);
        setSelectedTarget(undefined);
        setResetConfirmed(false);
        setFeedback(result.data.length === 0 ? { tone: "error", text: "검색 조건에 맞는 활성 로컬 MFA 사용자가 없습니다." } : undefined);
      } catch (error) {
        setFeedback(policyFailure(error));
      }
    });
  }

  const previewIsCurrent = impact?.mode === mode
    && impact.gracePeriodDays === graceDays
    && impact.policyVersion === policy.version;
  return (
    <AdminPage id="main-content" className="max-w-[64rem]">
      <AdminPageHeader
        category={view === "policy" ? "인증" : "사용자·접근"}
        title={view === "policy" ? "MFA 정책" : "사용자 MFA 초기화"}
        description={view === "policy" ? "인증 제공자의 MFA 경계와 기존 등록을 유지하면서 로컬 계정의 인증 앱 사용 정책을 관리합니다." : "접근 복구가 필요한 사용자의 MFA 자격 증명과 활성 세션을 안전하게 초기화합니다."}
        aside={view === "policy" ? <Badge>정책 v{policy.version}</Badge> : undefined}
      />

      {view === "policy" ? <section className="mt-8 overflow-hidden rounded-xl border border-muted-border bg-surface shadow-xs" aria-labelledby="mfa-policy-title">
        <AdminSectionHeading><div><p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">VERSION {policy.version}</p><h2 id="mfa-policy-title">적용 대상</h2></div><p>정책 변경에는 최근 관리자 재인증이 필요합니다.</p></AdminSectionHeading>
        <AdminForm layout="panel" onSubmit={save} aria-busy={mutation.isPending}>
          <AdminFormSection title="정책 대상" description="로그인 시 MFA 등록을 요구할 로컬 사용자 범위를 선택합니다.">
            <AdminFormFieldSpan>
              <RadioCardGroup label="MFA 등록이 필요한 사용자" name="mode" options={POLICY_OPTIONS} value={mode} disabled={mutation.isPending} onValueChange={(nextMode) => { setMode(nextMode); setImpact(undefined); }} />
            </AdminFormFieldSpan>
          </AdminFormSection>
          <AdminFormSection title="등록 유예 기간" description="정책 대상자가 인증 앱과 복구 코드를 준비할 기간을 설정합니다.">
            <NumberField label="유예 기간(일)" min={0} max={30} step={1} value={graceDays} disabled={mutation.isPending} description="0일이면 다음 로그인 직후 접근이 제한됩니다." onValueChange={(nextValue) => { if (nextValue !== null) setGraceDays(nextValue); setImpact(undefined); }} />
          </AdminFormSection>
          <dl className="m-0 grid grid-cols-3 border-t border-muted-border max-[37.5rem]:grid-cols-1 [&>div]:px-5 [&>div]:py-4 [&_dt]:text-xs [&_dt]:text-subtle-foreground [&_dd]:mt-1 [&_dd]:font-mono [&_dd]:text-lg">
            <div><dt>적용 대상 계정</dt><dd>{previewIsCurrent ? impact.affectedUsers : "—"}</dd></div>
            <div><dt>등록 필요</dt><dd>{previewIsCurrent ? impact.unenrolledUsers : "—"}</dd></div>
            <div><dt>즉시 제한</dt><dd>{previewIsCurrent ? impact.immediatelyRestrictedUsers : "—"}</dd></div>
            <div><dt>등록된 로컬 관리자</dt><dd>{previewIsCurrent ? impact.enrolledLocalAdministrators : "—"}</dd></div>
          </dl>
          <AdminFormActions>
            <AdminFormActionNote>{mode === "off" ? "정책을 완화하면 접근은 즉시 복구되지만 이미 등록된 자격 증명은 해제하지 않습니다." : "활성 로컬 관리자 중 최소 한 명이 MFA와 복구 코드를 확인한 상태여야 합니다."}</AdminFormActionNote>
            <Button type="button" onClick={preview} disabled={mutation.isPending}>영향 검토</Button>
            <Button type="submit" variant="primary" disabled={mutation.isPending || !previewIsCurrent}>{mutation.isPending ? "적용 중…" : "정책 적용"}</Button>
          </AdminFormActions>
        </AdminForm>
      </section> : null}

      {view === "reset" ? <section className="mt-8 rounded-xl border border-border bg-surface p-5 [&_h2]:mt-0 [&_p]:mt-0 [&_p]:text-muted-foreground">
        <h2>다른 사용자의 MFA 초기화</h2>
        <p>대상의 MFA 자격 증명, 복구 코드, 진행 중인 등록과 모든 세션을 폐기합니다. 본인 계정 초기화는 허용되지 않습니다.</p>
        <form className="mt-4 grid gap-3 max-[48rem]:grid-cols-1 max-[48rem]:[&>label]:col-auto max-[48rem]:[&>[data-slot=button]]:w-full max-[48rem]:[&>[data-slot=button]]:justify-self-stretch [&>[data-slot=button]]:justify-self-start" onSubmit={search} role="search" aria-busy={mutation.isPending}>
          <TextField label="이메일 또는 표시 이름으로 찾기" name="query" required minLength={2} maxLength={200} autoComplete="off" />
          <Button type="submit" disabled={mutation.isPending}>사용자 검색</Button>
        </form>
        <form className="mt-4 grid gap-3 [&>[data-slot=button]]:justify-self-start" onSubmit={reset} aria-busy={mutation.isPending}>
          {targets.length > 0 ? <RadioCardGroup label="초기화할 계정 선택" name="resetTarget" options={targets.map((target) => ({ value: target.credentialGeneration, label: target.displayName, description: target.email }))} value={selectedTarget?.credentialGeneration ?? ""} onValueChange={(credentialGeneration) => { setSelectedTarget(targets.find((target) => target.credentialGeneration === credentialGeneration)); setResetConfirmed(false); }} /> : null}
          {selectedTarget ? <div className="grid gap-3 rounded-lg border border-warning bg-subtle p-4"><p><strong>{selectedTarget.displayName}</strong> ({selectedTarget.email}) 계정을 초기화합니다.</p><CheckboxField checked={resetConfirmed} onCheckedChange={setResetConfirmed} label="이 계정의 MFA, 복구 코드와 모든 활성 세션이 폐기됨을 이해했습니다." /></div> : null}
          <Button type="submit" variant="danger" disabled={mutation.isPending || !selectedTarget || !resetConfirmed}>MFA와 세션 초기화</Button>
        </form>
      </section> : null}

      {feedback ? <div className={`flex items-center justify-between gap-3 rounded-lg border p-4 ${feedback.tone === "error" ? "border-danger text-danger" : "border-success"}`} role={feedback.tone === "error" ? "alert" : "status"}><span>{feedback.text}</span>{feedback.reconcile ? <Button onClick={() => router.refresh()}>최신 상태 불러오기</Button> : null}</div> : null}
    </AdminPage>
  );
}

function policyFailure(error: unknown): { readonly tone: "error"; readonly text: string; readonly reconcile?: boolean } {
  if (error instanceof ApiError && (error.status === 412 || error.status === 428)) return { tone: "error", text: "정책 상태가 변경되었거나 활성 로컬 관리자 안전 조건을 충족하지 못했습니다. 새로 고친 뒤 영향을 다시 검토하세요.", reconcile: true };
  if (error instanceof ApiError && error.status === 403) return { tone: "error", text: "최근 관리자 재인증이 필요합니다." };
  return { tone: "error", text: "변경을 안전하게 반영하지 못했습니다. 기존 정책은 그대로 유지됩니다." };
}
