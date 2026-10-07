"use client";

import { ApiError, previewMfaPolicy, resetUserMfa, searchMfaResetTargets, updateMfaPolicy } from "@nuriteo/api-client";
import type { MfaPolicy, MfaPolicyImpact, MfaPolicyMode, MfaResetTarget } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";

const POLICY_OPTIONS: readonly { readonly value: MfaPolicyMode; readonly label: string; readonly description: string }[] = [
  { value: "off", label: "Optional", description: "Users choose whether to keep MFA enabled." },
  { value: "administrators", label: "Administrators", description: "Require active local instance administrators." },
  { value: "all_local_users", label: "All local users", description: "Require every active account with a local password." }
];

export function MfaPolicyEditor({ initial }: { readonly initial: MfaPolicy }) {
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
        setFeedback({ tone: "success", text: "MFA policy and enrollment deadlines were reconciled." });
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
        setFeedback({ tone: "success", text: "The target MFA credential and sessions were reset." });
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
        setFeedback(result.data.length === 0 ? { tone: "error", text: "No active enrolled local user matched that search." } : undefined);
      } catch (error) {
        setFeedback(policyFailure(error));
      }
    });
  }

  const previewIsCurrent = impact?.mode === mode
    && impact.gracePeriodDays === graceDays
    && impact.policyVersion === policy.version;
  return (
    <main id="main-content" className="workspace-page admin-mfa-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">Instance administration</p>
        <h1>MFA policy</h1>
        <p>Require TOTP for local accounts while preserving identity-provider MFA boundaries and existing user enrollment.</p>
      </header>

      <section className="admin-settings" aria-labelledby="mfa-policy-title">
        <div className="admin-section-heading"><div><p className="eyebrow">Version {policy.version}</p><h2 id="mfa-policy-title">Enforcement</h2></div><p>Changing policy requires recent administrator reauthentication.</p></div>
        <form className="admin-setting-list" onSubmit={save} aria-busy={mutation.isPending}>
          <fieldset className="mfa-policy-options">
            <legend>Who must enroll</legend>
            {POLICY_OPTIONS.map((option) => (
              <label key={option.value} className="mfa-policy-option">
                <input type="radio" name="mode" value={option.value} checked={mode === option.value} disabled={mutation.isPending} onChange={() => { setMode(option.value); setImpact(undefined); }} />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </label>
            ))}
          </fieldset>
          <div className="mfa-policy-grace">
            <label htmlFor="mfa-grace-days">Grace period</label>
            <div><input id="mfa-grace-days" type="number" min="0" max="30" step="1" value={graceDays} disabled={mutation.isPending} onChange={(event) => { setGraceDays(Number(event.currentTarget.value)); setImpact(undefined); }} /><span>days</span></div>
            <p>Seven days is the default. Zero restricts affected accounts immediately after sign-in.</p>
          </div>
          <dl className="mfa-impact-preview">
            <div><dt>Candidate target accounts</dt><dd>{previewIsCurrent ? impact.affectedUsers : "—"}</dd></div>
            <div><dt>Need enrollment</dt><dd>{previewIsCurrent ? impact.unenrolledUsers : "—"}</dd></div>
            <div><dt>Immediately restricted</dt><dd>{previewIsCurrent ? impact.immediatelyRestrictedUsers : "—"}</dd></div>
            <div><dt>Enrolled local administrators</dt><dd>{previewIsCurrent ? impact.enrolledLocalAdministrators : "—"}</dd></div>
          </dl>
          <div className="mfa-policy-actions">
            <p>{mode === "off" ? "Relaxing policy restores access immediately but never disables enrolled credentials." : "At least one active local administrator must already have confirmed MFA and recovery codes."}</p>
            <Button type="button" onClick={preview} disabled={mutation.isPending}>Review impact</Button>
            <Button type="submit" variant="primary" disabled={mutation.isPending || !previewIsCurrent}>{mutation.isPending ? "Applying…" : "Apply policy"}</Button>
          </div>
        </form>
      </section>

      <section className="mfa-card admin-mfa-reset">
        <h2>Reset another user’s MFA</h2>
        <p>This revokes the target’s MFA credential, recovery codes, pending enrollment, and all sessions. Self-reset is rejected.</p>
        <form className="mfa-code-form" onSubmit={search} role="search" aria-busy={mutation.isPending}>
          <label htmlFor="mfa-reset-search">Find by email or display name</label>
          <input id="mfa-reset-search" name="query" required minLength={2} maxLength={200} autoComplete="off" />
          <Button type="submit" disabled={mutation.isPending}>Search users</Button>
        </form>
        <form className="mfa-code-form" onSubmit={reset} aria-busy={mutation.isPending}>
          {targets.length > 0 ? <fieldset><legend>Select the account to reset</legend>{targets.map((target) => (
            <label key={target.credentialGeneration} className="mfa-policy-option">
              <input type="radio" name="resetTarget" checked={selectedTarget?.credentialGeneration === target.credentialGeneration} onChange={() => { setSelectedTarget(target); setResetConfirmed(false); }} />
              <span><strong>{target.displayName}</strong><small>{target.email}</small></span>
            </label>
          ))}</fieldset> : null}
          {selectedTarget ? <div className="mfa-reset-confirmation"><p>You are resetting <strong>{selectedTarget.displayName}</strong> ({selectedTarget.email}).</p><label><input type="checkbox" checked={resetConfirmed} onChange={(event) => setResetConfirmed(event.currentTarget.checked)} /> I understand this revokes MFA, recovery codes, and every active session for this account.</label></div> : null}
          <Button type="submit" variant="danger" disabled={mutation.isPending || !selectedTarget || !resetConfirmed}>Reset MFA and sessions</Button>
        </form>
      </section>

      {feedback ? <div className={`mfa-feedback mfa-feedback--${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}><span>{feedback.text}</span>{feedback.reconcile ? <Button onClick={() => router.refresh()}>Reload latest</Button> : null}</div> : null}
    </main>
  );
}

function policyFailure(error: unknown): { readonly tone: "error"; readonly text: string; readonly reconcile?: boolean } {
  if (error instanceof ApiError && (error.status === 412 || error.status === 428)) return { tone: "error", text: "Policy state changed or the active local administrator safety condition is not satisfied. Reload and review impact.", reconcile: true };
  if (error instanceof ApiError && error.status === 403) return { tone: "error", text: "Recent administrator reauthentication is required." };
  return { tone: "error", text: "The change could not be committed safely. Existing policy remains in effect." };
}
