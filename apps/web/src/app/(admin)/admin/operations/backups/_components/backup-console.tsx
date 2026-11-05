"use client";

import type { AdminBackupConsole as BackupState, AdminBackupOperationCollection, AdminBackupOperationKind, AdminBackupPolicyUpdate } from "@nuriteo/api-client";
import Link from "next/link";
import type { ReactNode } from "react";

import { AdminForm, AdminFormActionNote, AdminFormActions, AdminFormSection } from "@/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminPageHeader } from "@/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminFeedback, AdminNote, AdminPage, AdminSection, AdminSectionHeading, AdminSummary } from "@/app/(admin)/admin/_components/admin-surface.tsx";
import { backupConsoleStyles } from "@/app/(admin)/admin/operations/backups/_components/backup-console.styles.ts";
import { backupActionLabel, useBackupConsole, useRetentionField } from "@/app/(admin)/admin/operations/backups/_hooks/use-backup-console.ts";
import { buttonVariants } from "@/components/ui/button.styles.ts";
import { Button } from "@/components/ui/button.tsx";
import { SelectField, TextField } from "@/components/ui/field.tsx";
import { NumberField } from "@/components/ui/number-field.tsx";
import { RadioCardGroup } from "@/components/ui/radio-group.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";

const styles = backupConsoleStyles();
const TIMEZONE_OPTIONS = [
  { value: "Asia/Seoul", label: "대한민국 표준시 (Asia/Seoul)" },
  { value: "UTC", label: "협정 세계시 (UTC)" },
  { value: "Asia/Tokyo", label: "일본 표준시 (Asia/Tokyo)" },
  { value: "Europe/London", label: "영국 시간 (Europe/London)" },
  { value: "America/New_York", label: "미국 동부 시간 (America/New_York)" }
] as const;

export function BackupConsole({ initial, initialOperations = { items: initial.operations, nextCursor: null }, view = "overview" }: { readonly initial: BackupState; readonly initialOperations?: AdminBackupOperationCollection; readonly view?: "actions" | "overview" | "policy" }) {
  const {
    draft,
    feedback,
    mutation,
    nextOperationPage,
    operationPage,
    operationPageIndex,
    operationPageLoading,
    operationPages,
    previousOperationPage,
    run,
    savePolicy,
    setDraft,
    state
  } = useBackupConsole(initial, initialOperations);

  return (
    <AdminPage id="main-content" contentWidth="standard">
      {view === "overview" ? null : <Link className="inline-flex w-fit items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground" href="/admin/operations/backups"><span aria-hidden="true">←</span>백업과 복구</Link>}
      <AdminPageHeader
        category="운영"
        title={view === "policy" ? "백업 정책" : (function () {
    if (view === "actions") {
        return ("백업 작업 실행");
    }
    return ("백업과 복구");
})()}
        description={view === "policy" ? "자동 백업 일정과 복구 지점 보존 기준을 설정합니다." : (function () {
    if (view === "actions") {
        return ("즉시 백업, 복구 훈련 또는 보존 대상 정리를 명시적으로 실행합니다.");
    }
    return ("복구 가능 상태와 최근 작업을 확인하고, 필요한 관리 작업으로 이동합니다.");
})()}
        aside={view === "overview" ? <div className="flex flex-wrap items-center gap-2"><AdminSummary>
          <span className="shrink-0 rounded-full border border-success px-3 py-1 text-xs font-medium text-foreground data-[state=degraded]:border-warning" data-state={(function () {
    if (state.alerts.length === 0) {
        return ("nominal");
    }
    return ("degraded");
})()}>
            {(function () {
    if (state.alerts.length === 0) {
        return ("정상");
    }
    return ("확인 필요");
})()}
          </span>
          <span>복구 지점 {state.restorePoints.length}개</span>
        </AdminSummary><Link className={buttonVariants({ size: "sm", variant: "secondary" })} href="/admin/operations/backups/policy">정책 설정</Link><Link className={buttonVariants({ size: "sm", variant: "primary" })} href="/admin/operations/backups/actions">작업 실행</Link></div> : null}
      />

      {view === "overview" && state.alerts.length > 0 ? (
        <AdminSection className="border-warning [&_ul]:m-0 [&_ul]:list-none [&_ul]:border-t [&_ul]:border-muted-border [&_ul]:p-0 [&_li]:flex [&_li]:items-start [&_li]:justify-between [&_li]:gap-4 [&_li]:border-b [&_li]:border-muted-border [&_li]:px-4 [&_li]:py-3 [&_li:last-child]:border-b-0 max-[37.5rem]:[&_li]:flex-col max-[37.5rem]:[&_li]:items-stretch" aria-labelledby="backup-alerts-title">
          <AdminSectionHeading><h2 id="backup-alerts-title">백업 알림</h2></AdminSectionHeading>
          <ul>{state.alerts.map((alert) => <li key={alert.code}><strong>{backupAlertMessage(alert.code, alert.message)}</strong><span>{(function () {
    if (alert.level === "critical") {
        return ("긴급");
    }
    return ("주의");
})()}</span></li>)}</ul>
        </AdminSection>
      ) : null}

      {view === "actions" ? <AdminSection aria-labelledby="backup-actions-title">
        <AdminSectionHeading>
          <div><p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">즉시 실행</p><h2 id="backup-actions-title">관리자 작업</h2></div>
        </AdminSectionHeading>
        <div className="grid border-t border-muted-border" aria-busy={mutation.isPending}>
          <BackupActionRow title="새 복구 지점 만들기" description="현재 데이터로 백업을 즉시 생성하고 작업 대기열에서 진행 상태를 추적합니다."><Button type="button" variant="primary" disabled={mutation.isPending} onClick={() => void run("create")}>지금 백업</Button></BackupActionRow>
          <BackupActionRow title="복원 가능성 검증하기" description="가장 최근 백업을 격리 환경에서 복원해 실제 복구 가능 여부를 확인합니다."><Button type="button" variant="secondary" disabled={mutation.isPending} onClick={() => void run("drill")}>복구 훈련 실행</Button></BackupActionRow>
          <BackupActionRow danger title="미보존 백업 정리하기" description={`미리보기에서 확인한 보존 대상이 아닌 백업 ${state.pruneCandidates}개를 정리 대기열에 추가합니다.`}><Button type="button" variant="danger" disabled={mutation.isPending || state.pruneCandidates === 0} onClick={() => void run("prune")}>정리 대상 {state.pruneCandidates}개 처리</Button></BackupActionRow>
        </div>
        <AdminNote>최근 관리자 재인증이 필요합니다. 정리는 현재 미리보기에서 확인한 미보존 후보만 대기열에 추가합니다.</AdminNote>
      </AdminSection> : null}

      {view === "policy" ? <AdminForm className="overflow-hidden rounded-lg border border-muted-border bg-surface" onSubmit={savePolicy}>
        <AdminSectionHeading>
          <div><p className="m-0 mb-3 text-xs font-semibold tracking-[0.08em] text-accent-foreground">정책 버전 {state.policy.version}</p><h2>백업 정책</h2></div>
          <p>저장한 변경 사항은 다음 예약부터 적용됩니다.</p>
        </AdminSectionHeading>
        <div className={styles.formBody()}>
          <AdminFormSection orientation="stacked" title={<PolicySectionTitle step="1">백업 일정</PolicySectionTitle>} description="자동 백업을 켜고, 실제 운영자가 읽는 순서대로 실행 간격과 기준 시각을 설정합니다.">
            <div className={styles.toggle()}><RadioCardGroup layout="columns" label="자동 백업 상태" name="backupEnabled" options={[{ value: "enabled", label: "자동 백업 사용", description: "설정한 일정에 따라 새 복구 지점을 생성합니다." }, { value: "disabled", label: "자동 백업 사용 안 함", description: "예약 실행만 중지하며 기존 복구 지점은 유지합니다." }]} value={(function () {
    if (draft.enabled) {
        return ("enabled");
    }
    return ("disabled");
})()} onValueChange={(value) => setDraft({ ...draft, enabled: value === "enabled" })} /></div>
            <div className={styles.scheduleList()}>
              <div className={styles.settingRow()}>
                <div className={styles.settingCopy()}><span className={styles.metricTitle()}>실행 간격</span><span className={styles.metricDescription()}>마지막 실행을 기준으로 다음 백업을 예약합니다.</span></div>
                <div className={styles.metricControl()}><NumberField className={styles.scheduleNumber()} density="compact" disabled={!draft.enabled} label="실행 간격" labelHidden value={draft.intervalHours} min={1} max={168} onValueChange={(intervalHours) => { if (intervalHours !== null) setDraft({ ...draft, intervalHours }); }} required /><span className={styles.metricUnit()}>시간</span></div>
              </div>
              <div className={styles.settingRow()}>
                <div className={styles.settingCopy()}><span className={styles.metricTitle()}>기준 시간</span><span className={styles.metricDescription()}>운영팀이 사용하는 현지 시간으로 표시합니다.</span></div>
                <div className={styles.settingControls()}><TextField className={styles.scheduleTime()} density="compact" disabled={!draft.enabled} label="백업 기준 시각" labelHidden type="time" value={draft.scheduleTime} onChange={(event) => setDraft({ ...draft, scheduleTime: event.currentTarget.value })} required /><SelectField className={styles.timeZoneField()} density="compact" disabled={!draft.enabled} label="백업 기준 시간대" labelHidden options={timeZoneOptions(draft.scheduleTimezone)} value={draft.scheduleTimezone} onValueChange={(scheduleTimezone) => setDraft({ ...draft, scheduleTimezone })} required /></div>
              </div>
            </div>
          </AdminFormSection>
          <AdminFormSection orientation="stacked" title={<PolicySectionTitle step="2">복구 지점 보존</PolicySectionTitle>} description="보존 단위별 개수를 한눈에 비교하고, 필요한 단위만 무기한으로 전환합니다.">
            <div className={styles.retentionGrid()}>
              <RetentionField label="일간 복구 지점" description="매일의 마지막 성공 지점" value={draft.dailyRetention} max={365} update={(dailyRetention) => setDraft({ ...draft, dailyRetention })} />
              <RetentionField label="주간 복구 지점" description="매주의 대표 성공 지점" value={draft.weeklyRetention} max={104} update={(weeklyRetention) => setDraft({ ...draft, weeklyRetention })} />
              <RetentionField label="월간 복구 지점" description="매월의 대표 성공 지점" value={draft.monthlyRetention} max={120} update={(monthlyRetention) => setDraft({ ...draft, monthlyRetention })} />
              <PolicyNumberField label="실패 백업" description="진단을 위해 실패 기록을 보존합니다." unit="일" value={draft.failedRetentionDays} min={1} max={90} update={(failedRetentionDays) => setDraft({ ...draft, failedRetentionDays })} />
            </div>
          </AdminFormSection>
          <AdminFormSection orientation="stacked" title={<PolicySectionTitle step="3">안전 기준과 복구 훈련</PolicySectionTitle>} description="정리와 경고 임계값은 가까이 비교하고, 복구 훈련 일정은 별도로 구성합니다.">
            <div className={styles.operationsGrid()}>
              <PolicyNumberField label="미완료 업로드 정리" description="이 시간보다 오래된 업로드" unit="시간" value={draft.multipartCleanupHours} min={1} max={168} update={(multipartCleanupHours) => setDraft({ ...draft, multipartCleanupHours })} />
              <PolicyNumberField label="백업 지연 경고" description="성공 백업이 없는 시간" unit="시간" value={draft.warningAfterHours} min={1} max={720} update={(warningAfterHours) => setDraft({ ...draft, warningAfterHours })} />
              <PolicyNumberField label="긴급 전환 기준" description="연속 실패 횟수" unit="회" value={draft.criticalAfterFailures} min={1} max={100} update={(criticalAfterFailures) => setDraft({ ...draft, criticalAfterFailures })} />
            </div>
            <div className={styles.drillPanel()}>
              <div className={styles.drillHeader()}><span className={styles.drillTitle()}>정기 복구 훈련</span><span className={styles.drillDescription()}>백업 파일을 실제로 복원할 수 있는지 격리 환경에서 주기적으로 확인합니다.</span></div>
              <div className={styles.drillGrid()}>
                <SelectField density="compact" label="실행 주기" options={[{ value: "off", label: "사용 안 함" }, { value: "weekly", label: "매주" }, { value: "monthly", label: "매월" }, { value: "quarterly", label: "분기마다" }]} value={draft.drillFrequency} onValueChange={(drillFrequency) => setDraft({ ...draft, drillFrequency: drillFrequency as AdminBackupPolicyUpdate["drillFrequency"] })} />
                <TextField className="max-w-40" density="compact" disabled={draft.drillFrequency === "off"} label="기준 시각" type="time" value={draft.drillTime} onChange={(event) => setDraft({ ...draft, drillTime: event.currentTarget.value })} required />
                <SelectField className={styles.timeZoneField()} density="compact" disabled={draft.drillFrequency === "off"} label="기준 시간대" options={timeZoneOptions(draft.drillTimezone)} value={draft.drillTimezone} onValueChange={(drillTimezone) => setDraft({ ...draft, drillTimezone })} required />
              </div>
            </div>
          </AdminFormSection>
          <AdminFormActions><AdminFormActionNote>변경 전 현재 저장소 접근 권한과 최근 복구 훈련 결과를 확인하세요.</AdminFormActionNote><Button type="submit" variant="primary" disabled={mutation.isPending}>{(function () {
    if (mutation.isPending) {
        return ("저장 중…");
    }
    return ("정책 저장");
})()}</Button></AdminFormActions>
        </div>
      </AdminForm> : null}

      {feedback ? <AdminFeedback feedbackTone={(function () {
    if (feedback.error) {
        return ("danger");
    }
    return ("success");
})()} role={(function () {
    if (feedback.error) {
        return ("alert");
    }
    return ("status");
})()}>{feedback.text}</AdminFeedback> : null}

      {view === "overview" ? <AdminSection className="[&_ol]:m-0 [&_ol]:list-none [&_ol]:border-t [&_ol]:border-muted-border [&_ol]:p-0 [&_li]:flex [&_li]:items-start [&_li]:justify-between [&_li]:gap-4 [&_li]:border-b [&_li]:border-muted-border [&_li]:px-4 [&_li]:py-3 [&_li:last-child]:border-b-0 max-[37.5rem]:[&_li]:flex-col max-[37.5rem]:[&_li]:items-stretch" aria-labelledby="restore-points-title">
        <AdminSectionHeading><div><p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">검증된 상태</p><h2 id="restore-points-title">복구 지점</h2></div></AdminSectionHeading>
        {(function () {
    if (state.restorePoints.length === 0) {
        return (<AdminNote>사용 가능한 완료 복구 지점이 없습니다.</AdminNote>);
    }
    return ((
          <ol>{state.restorePoints.map((point) => <li key={point.id}><div><strong>{new Date(point.completedAt).toLocaleString("ko-KR")}</strong><span>{formatBytes(point.payloadBytes)} · 오브젝트 {point.objectCount}개 · {point.retainedAs.join(", ") || "미보존"}</span></div><Button size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => void run("verify", point.id)}>검증</Button></li>)}</ol>
        ));
})()}
      </AdminSection> : null}

      {view === "overview" ? <AdminSection aria-labelledby="backup-history-title">
        <AdminSectionHeading><div><p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">지속 작업 대기열</p><h2 id="backup-history-title">작업 기록</h2></div></AdminSectionHeading>
        {(function () {
    if (operationPage.items.length === 0) {
        return (<AdminNote>요청된 백업 작업이 없습니다.</AdminNote>);
    }
    return (<div className="overflow-x-auto border-t border-muted-border"><table className="w-full min-w-[46rem] border-collapse text-left text-sm"><thead className="bg-subtle text-xs text-muted-foreground"><tr><th className="px-4 py-2.5 font-medium" scope="col">작업</th><th className="px-4 py-2.5 font-medium" scope="col">실행 방식</th><th className="px-4 py-2.5 font-medium" scope="col">상태</th><th className="px-4 py-2.5 font-medium" scope="col">요청 시각</th></tr></thead><tbody>{operationPage.items.map((operation) => <tr className="border-t border-muted-border" key={operation.id}><td className="px-4 py-3 font-medium text-foreground">{actionLabel(operation.kind)}</td><td className="px-4 py-3 text-muted-foreground">{(function () {
    if (operation.source === "manual") {
        return ("관리자 실행");
    }
    return ("예약 실행");
})()}</td><td className="px-4 py-3"><span className="font-medium text-foreground">{operationStateLabel(operation.state)}</span>{(function () {
    if (operation.failureCode) {
        return (<span className="ml-2 text-xs text-danger">{operation.failureCode}</span>);
    }
    return (null);
})()}</td><td className="px-4 py-3 text-muted-foreground"><time dateTime={operation.requestedAt}>{new Date(operation.requestedAt).toLocaleString("ko-KR")}</time></td></tr>)}</tbody></table></div>);
})()}
        <footer className="flex items-center justify-between gap-4 border-t border-muted-border px-4 py-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch"><span className="text-xs text-muted-foreground">{operationPageIndex + 1}페이지 · 현재 {operationPage.items.length}건</span><nav className="flex justify-end gap-2 max-[37.5rem]:[&_[data-slot=button]]:flex-1" aria-label="백업 작업 기록 페이지 이동"><Button size="sm" disabled={operationPageIndex === 0 || operationPageLoading} onClick={previousOperationPage}>이전</Button><Button size="sm" variant="primary" disabled={(operationPageIndex >= operationPages.length - 1 && operationPage.nextCursor === null) || operationPageLoading} onClick={() => void nextOperationPage()}>{(function () {
    if (operationPageLoading) {
        return ("불러오는 중…");
    }
    return ("다음");
})()}</Button></nav></footer>
      </AdminSection> : null}
    </AdminPage>
  );
}

function BackupActionRow({ children, danger = false, description, title }: { readonly children: ReactNode; readonly danger?: boolean; readonly description: string; readonly title: string }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-muted-border px-5 py-4 last:border-b-0 max-[40rem]:flex-col max-[40rem]:items-stretch">
      <div className="grid gap-1"><strong className={danger ? "text-danger" : "text-foreground"}>{title}</strong><p className="m-0 max-w-[42rem] text-xs leading-5 text-muted-foreground">{description}</p></div>
      <div className="shrink-0 max-[40rem]:[&_[data-slot=button]]:w-full">{children}</div>
    </div>
  );
}

function PolicyNumberField({ description, label, max, min, unit, update, value }: { readonly description: string; readonly label: string; readonly max: number; readonly min: number; readonly unit: string; readonly update: (value: number) => void; readonly value: number }) {
  return (
    <div className={styles.metricCard()}>
      <div className={styles.metricCopy()}><span className={styles.metricTitle()}>{label}</span><span className={styles.metricDescription()}>{description}</span></div>
      <div className={styles.metricControl()}><NumberField className={styles.metricNumber()} density="compact" label={label} labelHidden value={value} min={min} max={max} onValueChange={(nextValue) => { if (nextValue !== null) update(nextValue); }} required /><span className={styles.metricUnit()}>{unit}</span></div>
    </div>
  );
}

function PolicySectionTitle({ children, step }: { readonly children: ReactNode; readonly step: string }) {
  return <span className={styles.sectionTitle()}><span aria-hidden="true" className={styles.sectionIndex()}>{step}</span>{children}</span>;
}

function RetentionField({ description, label, max, update, value }: { readonly description: string; readonly label: string; readonly max: number; readonly update: (value: number | null) => void; readonly value: number | null }) {
  const { changeFinite, lastFiniteValue } = useRetentionField(value);
  return (
    <div className={styles.metricCard()}>
      <div className={styles.metricCopy()}><span className={styles.metricTitle()}>{label}</span><span className={styles.metricDescription()}>{description}</span></div>
      <div className={styles.retentionControl()}>
        <SegmentedControl aria-label={`${label} 보존 방식`} size="compact" options={[{ value: "limited", label: "개수 지정" }, { value: "unlimited", label: "무기한" }]} value={value === null ? "unlimited" : "limited"} onValueChange={(mode) => update(mode === "unlimited" ? null : lastFiniteValue)} />
        <NumberField className={styles.retentionNumber()} density="compact" label={`${label} 개수`} labelHidden value={value ?? lastFiniteValue} min={0} max={max} disabled={value === null} onValueChange={(nextValue) => { if (nextValue !== null) changeFinite(nextValue, update); }} required />
      </div>
    </div>
  );
}

function actionLabel(kind: AdminBackupOperationKind) {
  return backupActionLabel(kind);
}

function operationStateLabel(state: AdminBackupOperationCollection["items"][number]["state"]) {
  return ({ queued: "대기 중", running: "실행 중", succeeded: "완료", failed: "실패", cancelled: "취소됨" })[state];
}

function formatBytes(value: string) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) return `${value}바이트`;
  return new Intl.NumberFormat("ko-KR", { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(bytes / 1_048_576);
}

function timeZoneOptions(current: string): readonly { readonly label: string; readonly value: string }[] {
  return TIMEZONE_OPTIONS.some((option) => option.value === current)
    ? TIMEZONE_OPTIONS
    : [{ value: current, label: current }, ...TIMEZONE_OPTIONS];
}

function backupAlertMessage(code: string, fallback: string): string {
  const messages: Readonly<Record<string, string>> = {
    automatic_backup_paused: "자동 백업이 일시 중지되어 있습니다.",
    consecutive_failures: "연속 백업 실패 횟수가 설정된 긴급 기준에 도달했습니다.",
    latest_backup_overdue: "최근 성공한 백업이 설정된 경고 시간을 초과했습니다.",
    no_restore_point: "아직 성공적으로 완료된 복구 지점이 없습니다."
  };
  return messages[code] ?? fallback;
}


