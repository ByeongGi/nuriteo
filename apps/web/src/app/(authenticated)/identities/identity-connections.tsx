"use client";

import { ApiError, unlinkOidcIdentity } from "@nuriteo/api-client";
import type { OidcIdentity } from "@nuriteo/api-client";
import { useState } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../lib/use-exclusive-mutation.ts";

export function IdentityConnections({ initialIdentities }: { readonly initialIdentities: readonly OidcIdentity[] }) {
  const mutation = useExclusiveMutation();
  const [identities, setIdentities] = useState(initialIdentities);
  const [message, setMessage] = useState<{ readonly error: boolean; readonly text: string }>();

  async function unlink(identity: OidcIdentity) {
    await mutation.run(async () => {
      setMessage(undefined);
      try {
        await unlinkOidcIdentity(createBrowserApiClient(), identity.providerId, { csrfToken: readCsrfCredential() });
        setIdentities((items) => items.filter((item) => item.providerId !== identity.providerId));
        setMessage({ error: false, text: `${identity.providerDisplayName} was disconnected. Your browser session was rotated.` });
      } catch (error) {
        setMessage({ error: true, text: error instanceof ApiError && error.status === 409 ? "Keep at least one usable sign-in method connected to this account." : "The identity could not be disconnected. Sign in again and retry." });
      }
    });
  }

  return <main id="main-content" className="workspace-page">
    <header className="workspace-page__intro"><p className="eyebrow">Account security</p><h1>Connected identities</h1><p>Review the identity providers that can sign in to this account. Disconnecting requires recent reauthentication.</p></header>
    <section aria-labelledby="identity-list-title"><h2 id="identity-list-title">Identity providers</h2>
      {identities.length === 0 ? <p>No external identity provider is connected.</p> : <ul className="record-list">{identities.map((identity) => <li key={identity.providerId}><div><strong>{identity.providerDisplayName}</strong><span>Connected {formatDate(identity.linkedAt)}</span><small>{identity.lastAuthenticatedAt === null ? "Not used since it was connected" : `Last used ${formatDate(identity.lastAuthenticatedAt)}`}</small></div><Button variant="danger" disabled={mutation.isPending} onClick={() => void unlink(identity)}>Disconnect</Button></li>)}</ul>}
    </section>
    {message ? <p className={`notification-feedback notification-feedback--${message.error ? "error" : "success"}`} role={message.error ? "alert" : "status"}>{message.text}</p> : null}
  </main>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
