"use client";

import { ApiError, unlinkOidcIdentity } from "@nuriteo/api-client";
import type { OidcIdentity } from "@nuriteo/api-client";
import { useState } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { ConfirmationDialog } from "../../../components/ui/confirmation-dialog.tsx";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../lib/use-exclusive-mutation.ts";

export function IdentityConnections({ initialIdentities }: { readonly initialIdentities: readonly OidcIdentity[] }) {
  const mutation = useExclusiveMutation();
  const [identities, setIdentities] = useState(initialIdentities);
  const [message, setMessage] = useState<{ readonly error: boolean; readonly text: string }>();
  const [pendingIdentity, setPendingIdentity] = useState<OidcIdentity>();

  async function unlink(identity: OidcIdentity) {
    await mutation.run(async () => {
      setMessage(undefined);
      try {
        await unlinkOidcIdentity(createBrowserApiClient(), identity.providerId, { csrfToken: readCsrfCredential() });
        setIdentities((items) => items.filter((item) => item.providerId !== identity.providerId));
        setPendingIdentity(undefined);
        setMessage({ error: false, text: `${identity.providerDisplayName} was disconnected. Your browser session was rotated.` });
      } catch (error) {
        setMessage({ error: true, text: error instanceof ApiError && error.status === 409 ? "Keep at least one usable sign-in method connected to this account." : "The identity could not be disconnected. Sign in again and retry." });
      }
    });
  }

  return <main id="main-content" className="workspace-page">
    <header className="workspace-page__intro"><p className="eyebrow">Account security</p><h1>Connected identities</h1><p>Review the identity providers that can sign in to this account. Disconnecting requires recent reauthentication.</p></header>
    <section aria-labelledby="identity-list-title"><h2 id="identity-list-title">Identity providers</h2>
      {identities.length === 0 ? <p>연결된 외부 계정이 없습니다.</p> : <ul className="record-list">{identities.map((identity) => <li key={identity.providerId}><div><strong>{identity.providerDisplayName}</strong><span>{formatDate(identity.linkedAt)} 연결</span><small>{identity.lastAuthenticatedAt === null ? "연결 후 사용 기록 없음" : `최근 사용 ${formatDate(identity.lastAuthenticatedAt)}`}</small></div><Button aria-label={`Disconnect ${identity.providerDisplayName}`} variant="danger" disabled={mutation.isPending} onClick={() => setPendingIdentity(identity)}>연결 해제</Button></li>)}</ul>}
    </section>
    {message ? <p className={`notification-feedback notification-feedback--${message.error ? "error" : "success"}`} role={message.error ? "alert" : "status"}>{message.text}</p> : null}
    <ConfirmationDialog
      busy={mutation.isPending}
      confirmLabel={mutation.isPending ? "해제 중…" : "연결 해제"}
      description={`${pendingIdentity?.providerDisplayName ?? "선택한 계정"}으로 더 이상 로그인할 수 없습니다. 다른 로그인 수단이 있는지 확인하세요.`}
      open={pendingIdentity !== undefined}
      title="연결된 계정을 해제할까요?"
      onCancel={() => setPendingIdentity(undefined)}
      onConfirm={() => { if (pendingIdentity) void unlink(pendingIdentity); }}
    />
  </main>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
