"use client";

import type { MfaPolicy, MfaPolicyMode } from "@nuriteo/api-client";

import { AdminForm, AdminFormActionNote, AdminFormActions, AdminFormFieldSpan, AdminFormSection } from "@/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminPageHeader } from "@/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminPage, AdminSection, AdminSectionHeading } from "@/app/(admin)/admin/_components/admin-surface.tsx";
import { useMfaPolicyEditor } from "@/app/(admin)/admin/_hooks/use-mfa-policy-editor.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { CheckboxField } from "@/components/ui/checkbox.tsx";
import { TextField } from "@/components/ui/field.tsx";
import { NumberField } from "@/components/ui/number-field.tsx";
import { RadioCardGroup } from "@/components/ui/radio-group.tsx";

const POLICY_OPTIONS: readonly { readonly value: MfaPolicyMode; readonly label: string; readonly description: string }[] = [
  { value: "off", label: "사용자 선택", description: "MFA 등록을 강제하지 않고 각 사용자가 직접 선택합니다." },
  { value: "administrators", label: "관리자만 필수", description: "활성 로컬 인스턴스 관리자에게만 등록을 요구합니다." },
  { value: "all_local_users", label: "모든 로컬 사용자 필수", description: "로컬 비밀번호를 사용하는 모든 활성 계정에 등록을 요구합니다." }
];

export function MfaPolicyEditor({ initial, view = "policy" }: { readonly initial: MfaPolicy; readonly view?: "policy" | "reset" }) {
  const {
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
    refresh,
    reset,
    resetConfirmed,
    save,
    search,
    selectTarget,
    selectedTarget,
    setResetConfirmed,
    targets
  } = useMfaPolicyEditor(initial);
  return (
    <AdminPage id="main-content" contentWidth="narrow">
      <AdminPageHeader
        category="접근 관리"
        title={view === "policy" ? "MFA 정책" : "접근 복구"}
        description={view === "policy" ? "인증 제공자의 MFA 경계와 기존 등록을 유지하면서 로컬 계정의 인증 앱 사용 정책을 관리합니다." : "접근 복구가 필요한 사용자의 MFA 자격 증명과 활성 세션을 안전하게 초기화합니다."}
        aside={view === "policy" ? <Badge>정책 v{policy.version}</Badge> : undefined}
      />

      {view === "policy" ? <AdminSection aria-labelledby="mfa-policy-title">
        <AdminSectionHeading><div><p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">VERSION {policy.version}</p><h2 id="mfa-policy-title">적용 대상</h2></div><p>정책 변경에는 최근 관리자 재인증이 필요합니다.</p></AdminSectionHeading>
        <AdminForm layout="panel" onSubmit={save} aria-busy={mutation.isPending}>
          <AdminFormSection title="정책 대상" description="로그인 시 MFA 등록을 요구할 로컬 사용자 범위를 선택합니다.">
            <AdminFormFieldSpan>
              <RadioCardGroup label="MFA 등록이 필요한 사용자" name="mode" options={POLICY_OPTIONS} value={mode} disabled={mutation.isPending} onValueChange={changeMode} />
            </AdminFormFieldSpan>
          </AdminFormSection>
          <AdminFormSection title="등록 유예 기간" description="정책 대상자가 인증 앱과 복구 코드를 준비할 기간을 설정합니다.">
            <NumberField label="유예 기간(일)" min={0} max={30} step={1} value={graceDays} disabled={mutation.isPending} description="0일이면 다음 로그인 직후 접근이 제한됩니다." onValueChange={changeGraceDays} />
          </AdminFormSection>
          <dl className="m-0 grid grid-cols-3 border-t border-muted-border max-[37.5rem]:grid-cols-1 [&>div]:px-5 [&>div]:py-4 [&_dt]:text-xs [&_dt]:text-subtle-foreground [&_dd]:mt-1 [&_dd]:font-mono [&_dd]:text-lg">
            <div><dt>적용 대상 계정</dt><dd>{(function () {
    if (previewIsCurrent) {
        return (impact?.affectedUsers);
    }
    return ("—");
})()}</dd></div>
            <div><dt>등록 필요</dt><dd>{(function () {
    if (previewIsCurrent) {
        return (impact?.unenrolledUsers);
    }
    return ("—");
})()}</dd></div>
            <div><dt>즉시 제한</dt><dd>{(function () {
    if (previewIsCurrent) {
        return (impact?.immediatelyRestrictedUsers);
    }
    return ("—");
})()}</dd></div>
            <div><dt>등록된 로컬 관리자</dt><dd>{(function () {
    if (previewIsCurrent) {
        return (impact?.enrolledLocalAdministrators);
    }
    return ("—");
})()}</dd></div>
          </dl>
          <AdminFormActions>
            <AdminFormActionNote>{(function () {
    if (mode === "off") {
        return ("정책을 완화하면 접근은 즉시 복구되지만 이미 등록된 자격 증명은 해제하지 않습니다.");
    }
    return ("활성 로컬 관리자 중 최소 한 명이 MFA와 복구 코드를 확인한 상태여야 합니다.");
})()}</AdminFormActionNote>
            <Button type="button" onClick={preview} disabled={mutation.isPending}>영향 검토</Button>
            <Button type="submit" variant="primary" disabled={mutation.isPending || !previewIsCurrent}>{(function () {
    if (mutation.isPending) {
        return ("적용 중…");
    }
    return ("정책 적용");
})()}</Button>
          </AdminFormActions>
        </AdminForm>
      </AdminSection> : null}

      {view === "reset" ? <AdminSection className="p-5 max-[37.5rem]:p-4 [&_h2]:m-0 [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-muted-foreground">
        <h2 className="text-base">복구할 사용자 찾기</h2>
        <p className="text-sm leading-6">이메일 또는 표시 이름으로 사용자를 확인한 뒤, MFA 자격 증명과 활성 세션을 초기화합니다.</p>
        <form className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 max-[40rem]:grid-cols-1 max-[40rem]:[&>[data-slot=button]]:w-full max-[40rem]:[&>[data-slot=button]]:justify-center" onSubmit={search} role="search" aria-busy={mutation.isPending}>
          <TextField label="이메일 또는 표시 이름으로 찾기" name="query" required minLength={2} maxLength={200} autoComplete="off" />
          <Button type="submit" disabled={mutation.isPending}>사용자 검색</Button>
        </form>
        {(function () {
    if (targets.length > 0) {
        return (<form className="mt-5 grid gap-4 border-t border-muted-border pt-5" onSubmit={reset} aria-busy={mutation.isPending}>
          <RadioCardGroup label="복구할 계정 선택" name="resetTarget" options={targets.map((target) => ({ value: target.credentialGeneration, label: target.displayName, description: target.email }))} value={selectedTarget?.credentialGeneration ?? ""} onValueChange={selectTarget} />
          {(function () {
    if (selectedTarget) {
        return (<div className="grid gap-3 rounded-lg border border-warning bg-subtle p-4"><p><strong>{selectedTarget.displayName}</strong> ({selectedTarget.email}) 계정의 인증 정보를 초기화합니다.</p><CheckboxField checked={resetConfirmed} onCheckedChange={setResetConfirmed} label="MFA, 복구 코드, 진행 중인 등록과 모든 활성 세션이 폐기됨을 확인했습니다." /><Button className="justify-self-start max-[40rem]:w-full" type="submit" variant="danger" disabled={mutation.isPending || !resetConfirmed}>인증 정보 초기화</Button></div>);
    }
    return (null);
})()}
        </form>);
    }
    return (null);
})()}
      </AdminSection> : null}

      {feedback ? <div className={`flex items-center justify-between gap-3 rounded-lg border p-4 ${(function () {
    if (feedback.tone === "error") {
        return ("border-danger text-danger");
    }
    return ("border-success");
})()}`} role={(function () {
    if (feedback.tone === "error") {
        return ("alert");
    }
    return ("status");
})()}><span>{feedback.text}</span>{(function () {
    if (feedback.reconcile) {
        return (<Button onClick={refresh}>최신 상태 불러오기</Button>);
    }
    return (null);
})()}</div> : null}
    </AdminPage>
  );
}


