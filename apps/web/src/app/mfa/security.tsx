"use client";

import {
  ApiError,
  beginMfaEnrollment,
  challengeMfa,
  confirmMfaEnrollment,
  deleteSession,
  disableMfa,
  recoverMfa
} from "@nuriteo/api-client";
import type { MfaEnrollmentStart, MfaStatus } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../lib/api/browser-security.ts";
import { createQrMatrix } from "../../lib/qr-matrix.ts";
import { useExclusiveMutation } from "../../lib/use-exclusive-mutation.ts";

export function MfaSecurity({ status, displayName }: { readonly status: MfaStatus; readonly displayName: string }) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [enrollment, setEnrollment] = useState<MfaEnrollmentStart>();
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>();
  const [copiedRecoveryCodes, setCopiedRecoveryCodes] = useState(false);
  const [message, setMessage] = useState<{ readonly tone: "error" | "success"; readonly text: string }>();
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
    const code = String(form.get("code") ?? "");
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
        setMessage({ tone: "success", text: "Authenticator verified. Save every recovery code before continuing." });
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
      setMessage({ tone: "success", text: "Recovery codes copied. Store them safely before continuing." });
    } catch {
      setMessage({ tone: "error", text: "The browser could not copy the codes. Keep this screen open and allow clipboard access before retrying." });
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
    const code = String(form.get("code") ?? "");
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
            ? "Recovery succeeded. Other sessions were signed out; this does not count as recent reauthentication."
            : "Authenticator challenge succeeded and your session was rotated."
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
        setMessage({ tone: "success", text: "MFA was disabled and other sessions were signed out." });
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

  const deadline = status.deadlineAt === null ? undefined : new Date(status.deadlineAt);
  return (
    <main id="main-content" className="workspace-page mfa-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">Account security</p>
        <h1>Multi-factor authentication</h1>
        <p>{displayName}, protect your local account with a time-based authenticator and one-time recovery codes.</p>
      </header>

      {status.required ? (
        <section className={`mfa-notice ${status.restricted ? "mfa-notice--danger" : ""}`} role={status.restricted ? "alert" : "status"}>
          <strong>{status.restricted ? "Enrollment is required before continuing" : "Enrollment deadline"}</strong>
          <p>{deadline?.toLocaleString() ?? "Enroll now"}. Your account remains active and no project data is changed.</p>
        </section>
      ) : null}

      {!status.localAccount ? (
        <section className="mfa-card"><h2>Managed by your identity provider</h2><p>NURITEO TOTP is only used for local-password accounts.</p></section>
      ) : null}

      {status.localAccount && !status.enrolled && enrollment === undefined && recoveryCodes === undefined ? (
        <section className="mfa-card">
          <h2>Set up an authenticator</h2>
          <p>Recent reauthentication is required. Starting again replaces any unfinished enrollment.</p>
          <Button variant="primary" disabled={mutation.isPending} onClick={begin}>Start enrollment</Button>
        </section>
      ) : null}

      {enrollment !== undefined ? <EnrollmentPanel enrollment={enrollment} pending={mutation.isPending} onSubmit={confirm} /> : null}

      {recoveryCodes !== undefined ? (
        <section className="mfa-card mfa-recovery" aria-labelledby="recovery-title">
          <h2 id="recovery-title">Recovery codes — shown once</h2>
          <p>Store these outside this browser. Closing this screen will not allow the codes to be shown again.</p>
          <ul>{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
          <div className="mfa-actions">
            <Button onClick={copyRecoveryCodes}>Copy all codes</Button>
            <Button variant="primary" disabled={!copiedRecoveryCodes} onClick={finishRecoveryConfirmation}>
              {copiedRecoveryCodes ? "I saved the codes" : "Copy codes to continue"}
            </Button>
          </div>
        </section>
      ) : null}

      {status.enrolled && recoveryCodes === undefined ? (
        <div className="mfa-grid">
          <CodePanel title="Authenticator challenge" description="Verify a fresh six-digit code and rotate this session." pending={mutation.isPending} onSubmit={(event) => submitCode(event, false)} />
          <CodePanel title="Use a recovery code" description={`${status.recoveryCodesRemaining} one-time codes remain. Recovery does not grant recent reauthentication.`} pending={mutation.isPending} onSubmit={(event) => submitCode(event, true)} recovery />
          <section className="mfa-card">
            <h2>Disable MFA</h2>
            <p>Only available when instance policy does not require your account to remain enrolled.</p>
            <Button disabled={mutation.isPending || status.required} onClick={disable}>Disable MFA</Button>
          </section>
        </div>
      ) : null}

      {message ? <p className={`mfa-feedback mfa-feedback--${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p> : null}
      <nav className="mfa-safe-navigation" aria-label="Restricted account actions">
        {!status.restricted ? <Link href="/workspaces">Return to workspaces</Link> : null}
        <Button disabled={mutation.isPending} onClick={signOut}>Sign out or switch account</Button>
      </nav>
    </main>
  );
}

function EnrollmentPanel({ enrollment, pending, onSubmit }: { readonly enrollment: MfaEnrollmentStart; readonly pending: boolean; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const matrix = useMemo(() => createQrMatrix(enrollment.provisioningUri), [enrollment.provisioningUri]);
  return (
    <section className="mfa-card" aria-labelledby="enrollment-title">
      <h2 id="enrollment-title">Scan the enrollment QR code</h2>
      <p>The secret exists only in this response. Scan it now or enter the manual key.</p>
      <div className="mfa-enrollment-grid">
        <QrCode matrix={matrix} />
        <div><span className="mfa-label">Manual key</span><code className="mfa-secret">{enrollment.manualSecret}</code></div>
      </div>
      <form className="mfa-code-form" onSubmit={onSubmit} aria-busy={pending}>
        <label htmlFor="mfa-confirm-code">Six-digit code</label>
        <input id="mfa-confirm-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required />
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Verifying…" : "Verify and enable"}</Button>
      </form>
    </section>
  );
}

function QrCode({ matrix }: { readonly matrix: readonly (readonly boolean[])[] }) {
  const size = matrix.length;
  return (
    <svg className="mfa-qr" viewBox={`0 0 ${size + 8} ${size + 8}`} role="img" aria-label="Authenticator provisioning QR code" shapeRendering="crispEdges">
      <rect width={size + 8} height={size + 8} fill="white" />
      {matrix.flatMap((row, rowIndex) => row.map((dark, columnIndex) => dark ? <rect key={`${rowIndex}-${columnIndex}`} x={columnIndex + 4} y={rowIndex + 4} width="1" height="1" fill="black" /> : null))}
    </svg>
  );
}

function CodePanel({ title, description, pending, onSubmit, recovery = false }: { readonly title: string; readonly description: string; readonly pending: boolean; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void; readonly recovery?: boolean }) {
  const id = recovery ? "mfa-recovery-code" : "mfa-challenge-code";
  return (
    <section className="mfa-card">
      <h2>{title}</h2><p>{description}</p>
      <form className="mfa-code-form" onSubmit={onSubmit} aria-busy={pending}>
        <label htmlFor={id}>{recovery ? "Recovery code" : "Six-digit code"}</label>
        <input id={id} name="code" autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} minLength={6} maxLength={128} required />
        <Button type="submit" disabled={pending}>{pending ? "Checking…" : recovery ? "Recover account" : "Verify code"}</Button>
      </form>
    </section>
  );
}

function mfaFailure(error: unknown): { readonly tone: "error"; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { tone: "error", text: "The server may have committed this security change. Retry the same action to recover its protected one-time response." };
  if (error instanceof ApiError && error.status === 403) return { tone: "error", text: "Recent reauthentication or administrator policy approval is required." };
  if (error instanceof ApiError && error.status === 401) return { tone: "error", text: "The code was not accepted. Wait for a new code or use an unused recovery code." };
  if (error instanceof ApiError && (error.status === 409 || error.status === 412)) return { tone: "error", text: "MFA state changed elsewhere. Reload before trying again." };
  return { tone: "error", text: "The security change could not be completed safely. Nothing was exposed; retry shortly." };
}
