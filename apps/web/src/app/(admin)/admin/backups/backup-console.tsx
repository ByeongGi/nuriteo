"use client";

import {
  ApiError,
  enqueueAdminBackupOperation,
  updateAdminBackupPolicy
} from "@nuriteo/api-client";
import type {
  AdminBackupConsole as BackupState,
  AdminBackupOperationKind,
  AdminBackupPolicyUpdate
} from "@nuriteo/api-client";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { SwitchField } from "#src/components/ui/switch.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { NumberField } from "#src/components/ui/number-field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminForm, AdminFormActionNote, AdminFormActions, AdminFormSection } from "#src/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminNote, AdminPage, AdminSectionHeading, AdminSummary } from "#src/app/(admin)/admin/_components/admin-surface.tsx";
import { backupConsoleStyles } from "#src/app/(admin)/admin/backups/backup-console.styles.ts";

const styles = backupConsoleStyles();

export function BackupConsole({ initial }: { readonly initial: BackupState }) {
  const mutation = useExclusiveMutation();
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState<AdminBackupPolicyUpdate>(initial.policy);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await updateAdminBackupPolicy(createBrowserApiClient(), draft, {
          headers: {
            "if-match": `"backup-policy-v${state.policy.version}"`,
            "x-csrf-token": readCsrfCredential()
          }
        });
        setState(result.data);
        setDraft(result.data.policy);
        setFeedback({ error: false, text: "백업 정책을 저장하고 감사 로그에 기록했습니다." });
      } catch (error) {
        setFeedback({ error: true, text: backupError(error) });
      }
    });
  }

  async function run(kind: AdminBackupOperationKind, backupId: string | null = null) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await enqueueAdminBackupOperation(
          createBrowserApiClient(),
          { kind, backupId },
          { headers: { "x-csrf-token": readCsrfCredential() } }
        );
        setState(result.data);
        setFeedback({
          error: false,
          text: `${actionLabel(kind)} 작업을 대기열에 추가했습니다. 장기 실행 작업은 브라우저 요청이 끝난 뒤에도 계속됩니다.`
        });
      } catch (error) {
        setFeedback({ error: true, text: backupError(error) });
      }
    });
  }

  return (
    <AdminPage id="main-content">
      <AdminPageHeader
        category="백업"
        title="백업과 복구"
        description="복구 지점 일정과 보존 정책을 관리하고 격리된 복구 검증을 실행하세요."
        aside={<AdminSummary>
          <span className="status-badge" data-state={state.alerts.length === 0 ? "nominal" : "degraded"}>
            {state.alerts.length === 0 ? "정상" : "확인 필요"}
          </span>
          <span>복구 지점 {state.restorePoints.length}개</span>
        </AdminSummary>}
      />

      {state.alerts.length > 0 ? (
        <section className="admin-update-blockers" aria-labelledby="backup-alerts-title">
          <AdminSectionHeading><h2 id="backup-alerts-title">백업 알림</h2></AdminSectionHeading>
          <ul>{state.alerts.map((alert) => <li key={alert.code}><strong>{alert.message}</strong><span>{alert.level}</span></li>)}</ul>
        </section>
      ) : null}

      <section className="admin-update-approval" aria-labelledby="backup-actions-title">
        <AdminSectionHeading>
          <div><p className="eyebrow">즉시 실행</p><h2 id="backup-actions-title">관리자 작업</h2></div>
        </AdminSectionHeading>
        <div className="admin-backup-actions" aria-busy={mutation.isPending}>
          <Button type="button" disabled={mutation.isPending} onClick={() => void run("create")}>지금 백업</Button>
          <Button type="button" variant="secondary" disabled={mutation.isPending} onClick={() => void run("drill")}>복구 훈련 실행</Button>
          <Button type="button" variant="secondary" disabled={mutation.isPending || state.pruneCandidates === 0} onClick={() => void run("prune")}>
            정리 대상 {state.pruneCandidates}개 처리
          </Button>
        </div>
        <AdminNote>최근 관리자 재인증이 필요합니다. 정리는 현재 미리보기에서 확인한 미보존 후보만 대기열에 추가합니다.</AdminNote>
      </section>

      <AdminForm className="admin-update-approval admin-backup-policy" onSubmit={savePolicy}>
        <AdminSectionHeading>
          <div><p className="eyebrow">POLICY VERSION {state.policy.version}</p><h2>일정과 보존 정책</h2></div>
        </AdminSectionHeading>
        <div className={styles.formBody()}>
          <AdminFormSection title="백업 일정" description="자동 백업 실행 간격과 기준 시각을 설정합니다.">
            <div className={styles.toggle()}><SwitchField appearance="card" label="자동 백업" description="설정한 간격에 따라 백업을 생성합니다." checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} /></div>
            <PolicyNumberField label="백업 간격(시간)" value={draft.intervalHours} min={1} max={168} update={(intervalHours) => setDraft({ ...draft, intervalHours })} />
            <TextField label="백업 시각" type="time" value={draft.scheduleTime} onChange={(event) => setDraft({ ...draft, scheduleTime: event.currentTarget.value })} required />
            <TextField label="백업 시간대" value={draft.scheduleTimezone} maxLength={128} onChange={(event) => setDraft({ ...draft, scheduleTimezone: event.currentTarget.value })} required />
          </AdminFormSection>
          <AdminFormSection title="복구 지점 보존" description="일간·주간·월간 복구 지점과 실패 백업의 보존 범위를 정합니다.">
            <RetentionField label="일간 복구 지점" value={draft.dailyRetention} max={365} update={(dailyRetention) => setDraft({ ...draft, dailyRetention })} />
            <RetentionField label="주간 복구 지점" value={draft.weeklyRetention} max={104} update={(weeklyRetention) => setDraft({ ...draft, weeklyRetention })} />
            <RetentionField label="월간 복구 지점" value={draft.monthlyRetention} max={120} update={(monthlyRetention) => setDraft({ ...draft, monthlyRetention })} />
            <PolicyNumberField label="실패 백업 보존(일)" value={draft.failedRetentionDays} min={1} max={90} update={(failedRetentionDays) => setDraft({ ...draft, failedRetentionDays })} />
          </AdminFormSection>
          <AdminFormSection title="운영 기준" description="오래된 업로드 정리, 경고 단계와 정기 복구 훈련을 구성합니다.">
            <PolicyNumberField label="멀티파트 정리(시간)" value={draft.multipartCleanupHours} min={1} max={168} update={(multipartCleanupHours) => setDraft({ ...draft, multipartCleanupHours })} />
            <PolicyNumberField label="경고 기준(시간)" value={draft.warningAfterHours} min={1} max={720} update={(warningAfterHours) => setDraft({ ...draft, warningAfterHours })} />
            <PolicyNumberField label="심각 실패 횟수" value={draft.criticalAfterFailures} min={1} max={100} update={(criticalAfterFailures) => setDraft({ ...draft, criticalAfterFailures })} />
            <SelectField label="복구 훈련 주기" options={[{ value: "off", label: "사용 안 함" }, { value: "weekly", label: "매주" }, { value: "monthly", label: "매월" }, { value: "quarterly", label: "분기마다" }]} value={draft.drillFrequency} onValueChange={(drillFrequency) => setDraft({ ...draft, drillFrequency: drillFrequency as AdminBackupPolicyUpdate["drillFrequency"] })} />
            <TextField label="훈련 시각" type="time" value={draft.drillTime} onChange={(event) => setDraft({ ...draft, drillTime: event.currentTarget.value })} required />
            <TextField label="훈련 시간대" value={draft.drillTimezone} maxLength={128} onChange={(event) => setDraft({ ...draft, drillTimezone: event.currentTarget.value })} required />
          </AdminFormSection>
          <AdminFormActions>
            <AdminFormActionNote>변경 전 현재 저장소 접근 권한과 최근 복구 훈련 결과를 확인하세요.</AdminFormActionNote>
            <Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "저장 중…" : "정책 저장"}</Button>
          </AdminFormActions>
        </div>
      </AdminForm>

      {feedback ? <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "form-error admin-update-feedback" : "admin-update-feedback"}>{feedback.text}</p> : null}

      <section className="admin-update-history" aria-labelledby="restore-points-title">
        <AdminSectionHeading><div><p className="eyebrow">검증된 상태</p><h2 id="restore-points-title">복구 지점</h2></div></AdminSectionHeading>
        {state.restorePoints.length === 0 ? <AdminNote>사용 가능한 완료 복구 지점이 없습니다.</AdminNote> : (
          <ol>{state.restorePoints.map((point) => <li key={point.id}><div><strong>{new Date(point.completedAt).toLocaleString("ko-KR")}</strong><span>{formatBytes(point.payloadBytes)} · 오브젝트 {point.objectCount}개 · {point.retainedAs.join(", ") || "미보존"}</span></div><Button size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => void run("verify", point.id)}>검증</Button></li>)}</ol>
        )}
      </section>

      <section className="admin-update-history" aria-labelledby="backup-history-title">
        <AdminSectionHeading><div><p className="eyebrow">지속 작업 대기열</p><h2 id="backup-history-title">작업 기록</h2></div></AdminSectionHeading>
        {state.operations.length === 0 ? <AdminNote>요청된 백업 작업이 없습니다.</AdminNote> : <ol>{state.operations.map((operation) => <li key={operation.id}><div><strong>{actionLabel(operation.kind)}</strong><span>{operation.source} · {operation.state}{operation.failureCode ? ` · ${operation.failureCode}` : ""}</span></div><time dateTime={operation.requestedAt}>{new Date(operation.requestedAt).toLocaleString("ko-KR")}</time></li>)}</ol>}
      </section>
    </AdminPage>
  );
}

function PolicyNumberField({ label, max, min, update, value }: { readonly label: string; readonly max: number; readonly min: number; readonly update: (value: number) => void; readonly value: number }) {
  return <NumberField label={label} value={value} min={min} max={max} onValueChange={(nextValue) => { if (nextValue !== null) update(nextValue); }} required />;
}

function RetentionField({ label, max, update, value }: { readonly label: string; readonly max: number; readonly update: (value: number | null) => void; readonly value: number | null }) {
  return (
    <div className={styles.retention()}>
      <NumberField label={label} value={value ?? 0} min={0} max={max} disabled={value === null} onValueChange={(nextValue) => { if (nextValue !== null) update(nextValue); }} required />
      <CheckboxField label="무기한 보존" checked={value === null} onCheckedChange={(checked) => update(checked ? null : 0)} />
    </div>
  );
}

function actionLabel(kind: AdminBackupOperationKind) {
  return ({ create: "백업 생성", verify: "복구 지점 검증", drill: "복구 훈련", prune: "보존 대상 정리" })[kind];
}

function formatBytes(value: string) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) return `${value}바이트`;
  return new Intl.NumberFormat("ko-KR", { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(bytes / 1_048_576);
}

function backupError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return "이 변경에는 최근 관리자 재인증이 필요합니다.";
    if (error.status === 409) return "다른 백업 작업이 이미 대기 중이거나 실행 중입니다.";
    if (error.status === 412) return "다른 곳에서 백업 정책이 변경되었습니다. 페이지를 새로 고친 뒤 다시 시도하세요.";
    if (error.status === 422) return "일정, 시간대와 보존 한도를 확인해 주세요.";
  }
  return "백업 요청을 완료하지 못했습니다. 현재 상태를 새로 고친 뒤 다시 시도하세요.";
}
