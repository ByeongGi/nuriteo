"use client";

import type { OidcIdentity } from "@nuriteo/api-client";

import { identityConnectionsStyles } from "@/app/(authenticated)/account/identities/_components/identity-connections.styles.ts";
import { useIdentityConnections } from "@/app/(authenticated)/account/identities/_hooks/use-identity-connections.ts";
import { Button } from "@/components/ui/button.tsx";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";

export function IdentityConnections({ initialIdentities }: { readonly initialIdentities: readonly OidcIdentity[] }) {
  const styles = identityConnectionsStyles();
  const {
    cancelUnlink,
    confirmUnlink,
    identities,
    isPending,
    message,
    pendingIdentity,
    requestUnlink
  } = useIdentityConnections(initialIdentities);

  return <main id="main-content" className={styles.root()}>
    <PageHeader density="compact" eyebrow="계정" title="연결된 계정" description="누리터 로그인에 사용하는 회사 계정과 외부 인증 연결을 안전하게 관리하세요." />
    <aside className={styles.callout()}><strong className={styles.calloutTitle()}>연결을 해제하기 전에 확인하세요</strong><p className={styles.calloutDescription()}>마지막 로그인 수단은 해제할 수 없습니다. 로컬 계정이나 다른 OIDC 계정을 먼저 준비하세요.</p></aside>
    <section className={styles.panel()} aria-labelledby="identity-list-title"><header className={styles.panelHeader()}><div className={styles.panelHeading()}><h2 className={styles.panelTitle()} id="identity-list-title">로그인 계정</h2><p className={styles.panelDescription()}>조직의 인증 제공자를 통해 연결된 외부 계정입니다.</p></div><span className={styles.count()}>{identities.length}개</span></header>
      <IdentityList identities={identities} isPending={isPending} requestUnlink={requestUnlink} styles={styles} />
    </section>
    {message ? <p className={styles.feedback({ className: (function () {
    if (message.error) {
        return (styles.feedbackError());
    }
    return (styles.feedbackSuccess());
})() })} role={(function () {
    if (message.error) {
        return ("alert");
    }
    return ("status");
})()}>{message.text}</p> : null}
    <ConfirmationDialog
      busy={isPending}
      confirmLabel={isPending ? "해제 중…" : "연결 해제"}
      description={`${pendingIdentity?.providerDisplayName ?? "선택한 계정"}으로 더 이상 로그인할 수 없습니다. 다른 로그인 수단이 있는지 확인하세요.`}
      open={pendingIdentity !== undefined}
      title="연결된 계정을 해제할까요?"
      onCancel={cancelUnlink}
      onConfirm={confirmUnlink}
    />
  </main>;
}

function IdentityList({
  identities,
  isPending,
  requestUnlink,
  styles
}: {
  readonly identities: readonly OidcIdentity[];
  readonly isPending: boolean;
  readonly requestUnlink: (identity: OidcIdentity) => void;
  readonly styles: ReturnType<typeof identityConnectionsStyles>;
}) {
  if (identities.length === 0) {
    return <div className={styles.empty()}><strong className={styles.emptyTitle()}>연결된 외부 계정이 없습니다.</strong><span className={styles.emptyDescription()}>OIDC 계정으로 로그인하면 연결 정보가 이곳에 표시됩니다.</span></div>;
  }
  return <ul className={styles.list()}>{identities.map((identity) => {
    const lastUsed = identity.lastAuthenticatedAt === null
      ? "연결 후 사용 기록 없음"
      : `최근 사용 ${formatDate(identity.lastAuthenticatedAt)}`;
    return <li className={styles.item()} key={identity.providerId}><div className={styles.itemCopy()}><strong className={styles.itemTitle()}>{identity.providerDisplayName}</strong><span className={styles.itemMeta()}>{formatDate(identity.linkedAt)} 연결</span><small className={styles.itemDetail()}>{lastUsed}</small></div><Button className={styles.action()} size="sm" aria-label={`${identity.providerDisplayName} 연결 해제`} variant="danger" disabled={isPending} onClick={() => requestUnlink(identity)}>연결 해제</Button></li>;
  })}</ul>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
