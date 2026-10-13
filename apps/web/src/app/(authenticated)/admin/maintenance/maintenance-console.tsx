"use client";

import { ApiError } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";
import type { AdminMaintenanceStatus } from "./maintenance-model.ts";

export function MaintenanceConsole({ initial }: { readonly initial: AdminMaintenanceStatus }) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [status, setStatus] = useState(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const enabled = status.phase !== "active";

  async function update(nextEnabled: boolean) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const response = await createBrowserApiClient().put<AdminMaintenanceStatus>(
          "/admin/maintenance",
          { enabled: nextEnabled },
          { headers: { "x-csrf-token": readCsrfCredential() }, timeoutMs: 35_000 }
        );
        setStatus(response.data);
        setConfirmed(false);
        setFeedback({
          error: false,
          text: nextEnabled
            ? "Maintenance mode is active. Existing writes drained before the boundary closed."
            : "Maintenance mode ended. New writes are admitted again."
        });
        router.refresh();
      } catch (error) {
        setFeedback({ error: true, text: maintenanceError(error) });
      }
    });
  }

  return (
    <main id="main-content" className="workspace-page">
      <header className="workspace-page__intro admin-operations-intro">
        <div>
          <p className="eyebrow">Instance administration</p>
          <h1>Maintenance mode</h1>
          <p>
            Close write admission before backup recovery or an operator-led upgrade. Reads remain
            available while existing writes receive a bounded drain window.
          </p>
        </div>
        <div className="admin-operations-summary">
          <span className="status-badge" data-state={enabled ? "degraded" : "nominal"}>
            {phaseLabel(status.phase)}
          </span>
          <span>{status.activeWrites} active writes</span>
        </div>
      </header>

      <section className="admin-update-approval" aria-labelledby="maintenance-action-title">
        <header className="admin-section-heading">
          <div>
            <p className="eyebrow">Write boundary</p>
            <h2 id="maintenance-action-title">
              {enabled ? "Resume normal operation" : "Enter maintenance mode"}
            </h2>
          </div>
        </header>
        <div className="admin-update-approval__body" aria-busy={mutation.isPending}>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={mutation.isPending}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            {enabled
              ? "I verified the maintenance operation is complete and it is safe to admit writes."
              : "I understand new writes will be rejected and active writes must drain first."}
          </label>
          <Button
            type="button"
            disabled={!confirmed || mutation.isPending}
            onClick={() => void update(!enabled)}
          >
            {mutation.isPending
              ? enabled ? "Resuming…" : "Draining writes…"
              : enabled ? "Resume writes" : "Enter maintenance mode"}
          </Button>
        </div>
        <p className="admin-operations-card__note">
          Recent administrator reauthentication is required. A drain timeout stays fail-closed;
          reload this page before deciding whether to retry or resume.
        </p>
        {feedback ? (
          <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "form-error admin-update-feedback" : "admin-update-feedback"}>
            {feedback.text}
          </p>
        ) : null}
      </section>
    </main>
  );
}

function phaseLabel(phase: AdminMaintenanceStatus["phase"]): string {
  if (phase === "active") return "Writes open";
  if (phase === "draining") return "Draining writes";
  return "Read only";
}

function maintenanceError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return "Recent administrator reauthentication is required before this change.";
    }
    if (error.status === 504) {
      return "Active writes did not drain before the deadline. The instance remains fail-closed; reload status before continuing.";
    }
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") {
      return "The control result is unknown. Reload the current state before retrying.";
    }
  }
  return "Maintenance mode could not be changed. Reload the current state before retrying.";
}
