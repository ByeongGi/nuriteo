"use client";

import {
  issueActivationInvitation,
  reissueActivationInvitation,
  revokeActivationInvitation
} from "@nuriteo/api-client";
import type { ActivationInvitation } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { collaborationError, readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";

export function ActivationInvitations({
  invitations
}: {
  invitations: readonly ActivationInvitation[];
}) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
  const [error, setError] = useState<string>();

  async function mutate(
    operation: "activation-invitation-issue" | "activation-invitation-terminal",
    action: () => Promise<void>
  ) {
    await mutation.run(async () => {
      setError(undefined);
      setOneTimeUrl(undefined);
      setDeliveryNotice(undefined);
      try {
        await action();
        router.refresh();
      } catch (cause) {
        setError(collaborationError(cause, operation));
      }
    });
  }

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await mutate("activation-invitation-issue", async () => {
      const result = await issueActivationInvitation(
        createBrowserApiClient(),
        {
          email: String(data.get("email") ?? ""),
          expiresInSeconds: Number(data.get("expiresInSeconds"))
        },
        { csrfToken: readCsrfCredential() }
      );
      if (result.data.delivery === "email_queued") {
        setDeliveryNotice("The activation email is queued for delivery.");
      } else {
        setOneTimeUrl(result.data.activationUrl.consume());
      }
      form.reset();
    });
  }

  async function reissue(invitationId: string) {
    await mutate("activation-invitation-terminal", async () => {
      const result = await reissueActivationInvitation(
        createBrowserApiClient(),
        { invitationId },
        { csrfToken: readCsrfCredential() }
      );
      if (result.data.delivery === "email_queued") {
        setDeliveryNotice("The replacement activation email is queued for delivery.");
      } else {
        setOneTimeUrl(result.data.activationUrl.consume());
      }
    });
  }

  async function revoke(invitationId: string) {
    await mutate("activation-invitation-terminal", async () => {
      await revokeActivationInvitation(
        createBrowserApiClient(),
        invitationId,
        { csrfToken: readCsrfCredential() }
      );
    });
  }

  return (
    <main id="main-content" className="workspace-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">Instance administration</p>
        <h1>Activation invitations</h1>
        <p>
          Issue one-time account activation links. When email delivery is configured, the link is
          sent by email instead of being shown here.
        </p>
      </header>
      {oneTimeUrl ? (
        <section className="one-time-panel" aria-live="polite">
          <h2>Copy this link now</h2>
          <output>{oneTimeUrl}</output>
          <Button type="button" disabled={mutation.isPending} onClick={() => setOneTimeUrl(undefined)}>
            Clear link
          </Button>
        </section>
      ) : null}
      {deliveryNotice ? <p role="status">{deliveryNotice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <form className="collaboration-form" onSubmit={issue} aria-busy={mutation.isPending}>
        <label className="field-group">
          Invitee email
          <input name="email" type="email" required maxLength={320} disabled={mutation.isPending} />
        </label>
        <label className="field-group">
          Expires in seconds
          <input name="expiresInSeconds" type="number" min="3600" max="2592000" defaultValue="604800" required disabled={mutation.isPending} />
        </label>
        <Button type="submit" variant="primary" disabled={mutation.isPending}>
          {mutation.isPending ? "Working…" : "Issue invitation"}
        </Button>
      </form>
      <ul className="record-list" aria-label="Activation invitations">
        {invitations.map((invitation) => (
          <li key={invitation.id}>
            <div>
              <strong>{invitation.email}</strong>
              <span>{invitation.status} · expires {invitation.expires_at}</span>
            </div>
            {invitation.status === "pending" ? (
              <div className="record-actions">
                <Button type="button" disabled={mutation.isPending} onClick={() => void reissue(invitation.id)}>Reissue</Button>
                <Button type="button" disabled={mutation.isPending} onClick={() => void revoke(invitation.id)}>Revoke</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
