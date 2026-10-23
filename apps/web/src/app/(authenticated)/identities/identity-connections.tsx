"use client";

import { ApiError, unlinkOidcIdentity } from "@nuriteo/api-client";
import type { OidcIdentity } from "@nuriteo/api-client";
import { useState } from "react";

import { identityConnectionsStyles } from "#src/app/(authenticated)/identities/identity-connections.styles.ts";
import { Button } from "#src/components/ui/button.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

export function IdentityConnections({ initialIdentities }: { readonly initialIdentities: readonly OidcIdentity[] }) {
  const styles = identityConnectionsStyles();
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
        setMessage({ error: false, text: `${identity.providerDisplayName} 연결을 해제하고 브라우저 세션을 안전하게 갱신했습니다.` });
      } catch (error) {
        setMessage({ error: true, text: error instanceof ApiError && error.status === 409 ? "사용할 수 있는 로그인 수단을 하나 이상 유지해야 합니다." : "계정 연결을 해제하지 못했습니다. 다시 로그인한 뒤 시도하세요." });
      }
    });
  }

  return <main id="main-content" className={styles.root()}>
    <PageHeader eyebrow="계정" title="연결된 계정" description="누리터 로그인에 사용하는 회사 계정과 외부 인증 연결을 안전하게 관리하세요." />
    <aside className={styles.callout()}><strong className={styles.calloutTitle()}>연결을 해제하기 전에 확인하세요</strong><p className={styles.calloutDescription()}>마지막 로그인 수단은 해제할 수 없습니다. 로컬 계정이나 다른 OIDC 계정을 먼저 준비하세요.</p></aside>
    <section className={styles.panel()} aria-labelledby="identity-list-title"><header className={styles.panelHeader()}><div className={styles.panelHeading()}><h2 className={styles.panelTitle()} id="identity-list-title">로그인 계정</h2><p className={styles.panelDescription()}>조직의 인증 제공자를 통해 연결된 외부 계정입니다.</p></div><span className={styles.count()}>{identities.length}개</span></header>
      {identities.length === 0 ? <div className={styles.empty()}><strong className={styles.emptyTitle()}>연결된 외부 계정이 없습니다.</strong><span className={styles.emptyDescription()}>OIDC 계정으로 로그인하면 연결 정보가 이곳에 표시됩니다.</span></div> : <ul className={styles.list()}>{identities.map((identity) => <li className={styles.item()} key={identity.providerId}><div className={styles.itemCopy()}><strong className={styles.itemTitle()}>{identity.providerDisplayName}</strong><span className={styles.itemMeta()}>{formatDate(identity.linkedAt)} 연결</span><small className={styles.itemDetail()}>{identity.lastAuthenticatedAt === null ? "연결 후 사용 기록 없음" : `최근 사용 ${formatDate(identity.lastAuthenticatedAt)}`}</small></div><Button className={styles.action()} aria-label={`${identity.providerDisplayName} 연결 해제`} variant="danger" disabled={mutation.isPending} onClick={() => setPendingIdentity(identity)}>연결 해제</Button></li>)}</ul>}
    </section>
    {message ? <p className={styles.feedback({ className: message.error ? styles.feedbackError() : styles.feedbackSuccess() })} role={message.error ? "alert" : "status"}>{message.text}</p> : null}
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
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
