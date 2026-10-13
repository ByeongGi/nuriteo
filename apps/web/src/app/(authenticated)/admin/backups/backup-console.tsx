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
import type { FormEvent, ReactNode } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";

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
        setFeedback({ error: false, text: "Backup policy saved and recorded in the audit log." });
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
          text: `${actionLabel(kind)} queued. Long-running work continues outside this browser request.`
        });
      } catch (error) {
        setFeedback({ error: true, text: backupError(error) });
      }
    });
  }

  return (
    <main id="main-content" className="workspace-page">
      <header className="workspace-page__intro admin-operations-intro">
        <div>
          <p className="eyebrow">Instance administration</p>
          <h1>Backups</h1>
          <p>Schedule restore points, bound retention, and run isolated recovery drills.</p>
        </div>
        <div className="admin-operations-summary">
          <span className="status-badge" data-state={state.alerts.length === 0 ? "nominal" : "degraded"}>
            {state.alerts.length === 0 ? "Healthy" : "Attention"}
          </span>
          <span>{state.restorePoints.length} restore points</span>
        </div>
      </header>

      {state.alerts.length > 0 ? (
        <section className="admin-update-blockers" aria-labelledby="backup-alerts-title">
          <header className="admin-section-heading"><h2 id="backup-alerts-title">Backup alerts</h2></header>
          <ul>{state.alerts.map((alert) => <li key={alert.code}><strong>{alert.message}</strong><span>{alert.level}</span></li>)}</ul>
        </section>
      ) : null}

      <section className="admin-update-approval" aria-labelledby="backup-actions-title">
        <header className="admin-section-heading">
          <div><p className="eyebrow">Run now</p><h2 id="backup-actions-title">Operator actions</h2></div>
        </header>
        <div className="admin-backup-actions" aria-busy={mutation.isPending}>
          <Button type="button" disabled={mutation.isPending} onClick={() => void run("create")}>Create backup</Button>
          <Button type="button" variant="secondary" disabled={mutation.isPending} onClick={() => void run("drill")}>Run recovery drill</Button>
          <Button type="button" variant="secondary" disabled={mutation.isPending || state.pruneCandidates === 0} onClick={() => void run("prune")}>
            Prune {state.pruneCandidates} eligible
          </Button>
        </div>
        <p className="admin-operations-card__note">Recent administrator reauthentication is required. Prune only queues unretained candidates shown by the current dry-run count.</p>
      </section>

      <form className="admin-update-approval admin-backup-policy" onSubmit={savePolicy}>
        <header className="admin-section-heading">
          <div><p className="eyebrow">Policy version {state.policy.version}</p><h2>Schedule and retention</h2></div>
        </header>
        <div className="admin-backup-fields">
          <label><span>Automatic backups</span><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })} /></label>
          <NumberField label="Backup interval (hours)" value={draft.intervalHours} min={1} max={168} update={(intervalHours) => setDraft({ ...draft, intervalHours })} />
          <Field label="Backup time"><input aria-label="Backup time" type="time" value={draft.scheduleTime} onChange={(event) => setDraft({ ...draft, scheduleTime: event.currentTarget.value })} required /></Field>
          <Field label="Backup timezone"><input aria-label="Backup timezone" value={draft.scheduleTimezone} maxLength={128} onChange={(event) => setDraft({ ...draft, scheduleTimezone: event.currentTarget.value })} required /></Field>
          <RetentionField label="Daily restore points" value={draft.dailyRetention} max={365} update={(dailyRetention) => setDraft({ ...draft, dailyRetention })} />
          <RetentionField label="Weekly restore points" value={draft.weeklyRetention} max={104} update={(weeklyRetention) => setDraft({ ...draft, weeklyRetention })} />
          <RetentionField label="Monthly restore points" value={draft.monthlyRetention} max={120} update={(monthlyRetention) => setDraft({ ...draft, monthlyRetention })} />
          <NumberField label="Failed backup retention (days)" value={draft.failedRetentionDays} min={1} max={90} update={(failedRetentionDays) => setDraft({ ...draft, failedRetentionDays })} />
          <NumberField label="Multipart cleanup (hours)" value={draft.multipartCleanupHours} min={1} max={168} update={(multipartCleanupHours) => setDraft({ ...draft, multipartCleanupHours })} />
          <NumberField label="Warn after (hours)" value={draft.warningAfterHours} min={1} max={720} update={(warningAfterHours) => setDraft({ ...draft, warningAfterHours })} />
          <NumberField label="Critical failure count" value={draft.criticalAfterFailures} min={1} max={100} update={(criticalAfterFailures) => setDraft({ ...draft, criticalAfterFailures })} />
          <Field label="Recovery drill frequency">
            <select aria-label="Recovery drill frequency" value={draft.drillFrequency} onChange={(event) => setDraft({ ...draft, drillFrequency: event.currentTarget.value as AdminBackupPolicyUpdate["drillFrequency"] })}>
              <option value="off">Off</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option>
            </select>
          </Field>
          <Field label="Drill time"><input aria-label="Drill time" type="time" value={draft.drillTime} onChange={(event) => setDraft({ ...draft, drillTime: event.currentTarget.value })} required /></Field>
          <Field label="Drill timezone"><input aria-label="Drill timezone" value={draft.drillTimezone} maxLength={128} onChange={(event) => setDraft({ ...draft, drillTimezone: event.currentTarget.value })} required /></Field>
        </div>
        <div className="admin-backup-submit"><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save policy"}</Button></div>
      </form>

      {feedback ? <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "form-error admin-update-feedback" : "admin-update-feedback"}>{feedback.text}</p> : null}

      <section className="admin-update-history" aria-labelledby="restore-points-title">
        <header className="admin-section-heading"><div><p className="eyebrow">Verified state</p><h2 id="restore-points-title">Restore points</h2></div></header>
        {state.restorePoints.length === 0 ? <p className="admin-operations-card__note">No complete restore point is available.</p> : (
          <ol>{state.restorePoints.map((point) => <li key={point.id}><div><strong>{new Date(point.completedAt).toLocaleString()}</strong><span>{formatBytes(point.payloadBytes)} · {point.objectCount} objects · {point.retainedAs.join(", ") || "unretained"}</span></div><Button size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => void run("verify", point.id)}>Verify</Button></li>)}</ol>
        )}
      </section>

      <section className="admin-update-history" aria-labelledby="backup-history-title">
        <header className="admin-section-heading"><div><p className="eyebrow">Durable queue</p><h2 id="backup-history-title">Operation history</h2></div></header>
        {state.operations.length === 0 ? <p className="admin-operations-card__note">No backup operation has been requested.</p> : <ol>{state.operations.map((operation) => <li key={operation.id}><div><strong>{actionLabel(operation.kind)}</strong><span>{operation.source} · {operation.state}{operation.failureCode ? ` · ${operation.failureCode}` : ""}</span></div><time dateTime={operation.requestedAt}>{new Date(operation.requestedAt).toLocaleString()}</time></li>)}</ol>}
      </section>
    </main>
  );
}

function Field({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return <label><span>{label}</span>{children}</label>;
}

function NumberField({ label, max, min, update, value }: { readonly label: string; readonly max: number; readonly min: number; readonly update: (value: number) => void; readonly value: number }) {
  return <Field label={label}><input aria-label={label} type="number" value={value} min={min} max={max} onChange={(event) => update(event.currentTarget.valueAsNumber)} required /></Field>;
}

function RetentionField({ label, max, update, value }: { readonly label: string; readonly max: number; readonly update: (value: number | null) => void; readonly value: number | null }) {
  return (
    <label>
      <span>{label}</span>
      <input aria-label={label} type="number" value={value ?? 0} min={0} max={max} disabled={value === null} onChange={(event) => update(event.currentTarget.valueAsNumber)} required />
      <span><input type="checkbox" checked={value === null} onChange={(event) => update(event.currentTarget.checked ? null : 0)} /> Unlimited retention</span>
    </label>
  );
}

function actionLabel(kind: AdminBackupOperationKind) {
  return ({ create: "Backup creation", verify: "Restore-point verification", drill: "Recovery drill", prune: "Retention prune" })[kind];
}

function formatBytes(value: string) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) return `${value} bytes`;
  return new Intl.NumberFormat(undefined, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(bytes / 1_048_576);
}

function backupError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Recent administrator reauthentication is required before this change.";
    if (error.status === 409) return "Another backup operation is already queued or running.";
    if (error.status === 412) return "The backup policy changed elsewhere. Reload the page before retrying.";
    if (error.status === 422) return "Review the schedule, timezone, and retention limits.";
  }
  return "The backup request could not be completed. Reload the current state before retrying.";
}
