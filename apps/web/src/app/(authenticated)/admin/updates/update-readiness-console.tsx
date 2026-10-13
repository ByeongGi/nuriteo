"use client";

import { ApiError } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";
import type { AdminUpdateHistory, AdminUpdateReadiness } from "./update-model.ts";

export function UpdateReadinessConsole({
  readiness,
  history
}: {
  readonly readiness: AdminUpdateReadiness;
  readonly history: AdminUpdateHistory;
}) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function approve() {
    await mutation.run(async () => {
      setError(undefined);
      setNotice(undefined);
      try {
        await createBrowserApiClient().post(
          "/admin/updates/approval",
          { targetRelease: readiness.targetRelease, acknowledged: true },
          { headers: { "x-csrf-token": readCsrfCredential() } }
        );
        setAcknowledged(false);
        setNotice("Approval recorded. No update was started.");
        router.refresh();
      } catch (cause) {
        setError(approvalError(cause));
      }
    });
  }

  return (
    <main id="main-content" className="workspace-page">
      <header className="workspace-page__intro admin-operations-intro">
        <div>
          <p className="eyebrow">Instance administration</p>
          <h1>Update readiness</h1>
          <p>
            Review the redacted compatibility and preflight report. Approval records operator
            intent for the deployment workflow; it never starts an update.
          </p>
        </div>
        <div className="admin-operations-summary">
          <span className="status-badge" data-state={readiness.state === "ready" ? "nominal" : "degraded"}>
            {readiness.state === "ready" ? "Ready for approval" : readiness.state === "current" ? "Current" : "Blocked"}
          </span>
          <time dateTime={readiness.generatedAt}>{formatTimestamp(readiness.generatedAt)}</time>
        </div>
      </header>

      <div className="admin-update-grid">
        <section className="admin-operations-card" aria-labelledby="update-target-title">
          <header className="admin-section-heading">
            <div>
              <p className="eyebrow">Release path</p>
              <h2 id="update-target-title">Compatibility</h2>
            </div>
          </header>
          <dl className="admin-update-details">
            <Detail label="Installed release" value={readiness.currentRelease} />
            <Detail label="Target" value={readiness.targetRelease} />
            <Detail label="Schema" value={readiness.compatibility.schemaPolicy} />
            <Detail label="Stored objects" value={readiness.compatibility.objectPolicy} />
            <Detail label="Images" value={readiness.compatibility.imagePolicy} />
            <Detail label="Failure policy" value={readiness.compatibility.failurePolicy} />
          </dl>
          <p className="admin-operations-card__note">
            Image digests, storage endpoints, credentials, and backend errors are intentionally omitted.
          </p>
        </section>

        <section className="admin-operations-card" aria-labelledby="update-preflight-title">
          <header className="admin-section-heading">
            <div>
              <p className="eyebrow">Read-only check</p>
              <h2 id="update-preflight-title">Preflight</h2>
            </div>
            <span className="status-badge" data-state={readiness.preflight.state === "passed" ? "nominal" : "degraded"}>
              {readiness.preflight.state === "passed" ? "Passed" : "Stopped"}
            </span>
          </header>
          <dl className="admin-update-details">
            <Detail label="Schema state" value={readiness.preflight.schemaState ?? "Unavailable"} />
            <Detail label="Current migration" value={formatMigration(readiness.preflight.currentMigration)} />
            <Detail label="Target migration" value={formatMigration(readiness.preflight.targetMigration)} />
            <Detail label="Settings registry" value={`v${readiness.compatibility.configurationRegistryVersion}`} />
          </dl>
          <p className="admin-operations-card__note">
            The deployment helper must still verify the active image set and object storage before mutation.
          </p>
        </section>
      </div>

      {readiness.blockers.length > 0 ? (
        <section className="admin-update-blockers" aria-labelledby="update-blockers-title">
          <header className="admin-section-heading">
            <div>
              <p className="eyebrow">Upgrade Stop</p>
              <h2 id="update-blockers-title">Resolve blockers before approval</h2>
            </div>
          </header>
          <ul>
            {readiness.blockers.map((blocker) => (
              <li key={blocker.code}>
                <strong>{blocker.summary}</strong>
                <span>{blocker.operatorAction}</span>
                <code>{blocker.code}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="admin-update-approval" aria-labelledby="update-approval-title">
        <header className="admin-section-heading">
          <div>
            <p className="eyebrow">Explicit operator action</p>
            <h2 id="update-approval-title">Approval</h2>
          </div>
        </header>
        {readiness.approvalAllowed ? (
          <div className="admin-update-approval__body" aria-busy={mutation.isPending}>
            <label>
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={mutation.isPending}
                onChange={(event) => setAcknowledged(event.currentTarget.checked)}
              />
              I reviewed the blockers and understand this records approval only; it does not run an update.
            </label>
            <Button type="button" disabled={!acknowledged || mutation.isPending} onClick={approve}>
              {mutation.isPending ? "Recording approval…" : "Record update approval"}
            </Button>
          </div>
        ) : (
          <p className="admin-operations-card__note">
            {readiness.state === "current"
              ? "This instance is already on the current schema; approval is not applicable."
              : "Approval is unavailable while a preflight blocker remains."}
          </p>
        )}
        {notice ? <p role="status" className="admin-update-feedback">{notice}</p> : null}
        {error ? <p role="alert" className="form-error admin-update-feedback">{error}</p> : null}
      </section>

      <section className="admin-update-history" aria-labelledby="update-history-title">
        <header className="admin-section-heading">
          <div>
            <p className="eyebrow">Audit history</p>
            <h2 id="update-history-title">Recent update approvals</h2>
          </div>
        </header>
        {history.items.length === 0 ? (
          <p className="admin-operations-card__note">No update approval has been recorded.</p>
        ) : (
          <ol>
            {history.items.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.targetRelease}</strong>
                  <span>Approval recorded; execution was not started by this action.</span>
                </div>
                <time dateTime={item.occurredAt}>{formatTimestamp(item.occurredAt)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function formatMigration(value: number | null): string {
  return value === null ? "—" : String(value);
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value)) + " UTC";
}

function approvalError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "REAUTHENTICATION_REQUIRED" || error.status === 403) {
      return "Recent administrator reauthentication is required before approval.";
    }
    if (error.status === 409) {
      return "Readiness changed and approval was not recorded. Review the latest blockers.";
    }
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") {
      return "The approval result is unknown. Reload history before retrying.";
    }
  }
  return "Approval could not be recorded. No update was started.";
}
