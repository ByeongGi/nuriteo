"use client";

import type { MfaStatus } from "@nuriteo/api-client";
import dynamic from "next/dynamic";
import Link from "next/link";

import { useMfaSecurity } from "@/app/(public)/mfa/_hooks/use-mfa-security.ts";
import { mfaSecurityStyles } from "@/app/(public)/mfa/_components/security.styles.ts";
import { Button } from "@/components/ui/button.tsx";
import { CheckboxField } from "@/components/ui/checkbox.tsx";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/components/ui/settings-group.tsx";

import type { FormEvent } from "react";

const MfaEnrollmentPanel = dynamic(
  () => import("@/app/(public)/mfa/_components/mfa-enrollment-panel.tsx").then((module) => module.MfaEnrollmentPanel),
  {
    loading: () => <section className={mfaSecurityStyles().card()} aria-busy="true"><h2>인증 앱 설정을 준비하는 중입니다…</h2></section>,
    ssr: false
  }
);

type MfaSecurityView = "challenge" | "security" | "setup";

export function MfaSecurity({
  status,
  displayName,
  view = "security"
}: {
  readonly status: MfaStatus;
  readonly displayName: string;
  readonly view?: MfaSecurityView;
}) {
  const {
    begin,
    confirm,
    confirmingDisable,
    copiedRecoveryCodes,
    copyRecoveryCodes,
    disable,
    enrollment,
    finishRecoveryConfirmation,
    isPending,
    message,
    recoveryCodes,
    setConfirmingDisable,
    setCopiedRecoveryCodes,
    signOut,
    submitCode
  } = useMfaSecurity();

  const deadline = status.deadlineAt === null ? undefined : new Date(status.deadlineAt);
  const isSetupView = view === "setup";
  const isChallengeView = view === "challenge";
  const styles = mfaSecurityStyles({ standalone: view !== "security" });
  const securityHref = isSetupView ? "/mfa/setup" : (function () {
    if (isChallengeView) {
        return ("/mfa/challenge");
    }
    return ("/account/security");
})();
  const pageTitle = isSetupView ? "다단계 인증 설정" : (function () {
    if (isChallengeView) {
        return ("다단계 인증 확인");
    }
    return ("계정 보안");
})();
  const pageDescription = isSetupView
    ? `${displayName}님의 계정에 인증 앱을 연결하고 복구 코드를 보관합니다.`
    : (function () {
    if (isChallengeView) {
        return ("인증 앱의 새 코드 또는 사용하지 않은 복구 코드로 현재 세션을 확인합니다.");
    }
    return (`${displayName}님의 로컬 계정을 인증 앱과 일회용 복구 코드로 보호합니다.`);
})();
  return (
    <main id="main-content" className={styles.root()}>
      {view === "security" ? null : <nav className={styles.productBar()} aria-label="계정 보안 탐색">
        <Link className={styles.productBrand()} href={(function () {
    if (status.restricted) {
        return ("/mfa/setup");
    }
    return ("/workspaces");
})()}><span className={styles.brandMark()} aria-hidden="true">N</span><strong>NURITEO</strong></Link>
        {(function () {
    if (status.restricted) {
        return (<span className={styles.productStatus()}>계정 보호 설정이 필요합니다</span>);
    }
    return (<div className={styles.productNav()}><Link className={styles.productLink()} href="/workspaces">워크스페이스</Link><Link className={styles.productLink()} href="/account/identities">연결된 로그인</Link><Link className={styles.productLink()} aria-current="page" href={securityHref}>계정 보안</Link></div>);
})()}
      </nav>}
      <PageHeader density="compact" eyebrow="계정 / 보안" title={pageTitle} description={pageDescription} />

      {!isChallengeView ? (
        <SettingsGroup density="compact" title="보안 상태" description="현재 계정에 적용된 로그인 보호 상태입니다.">
          <SettingsRow density="compact" title="다중 인증" description={(function () {
    if (status.localAccount) {
        return ("인증 앱 기반");
    }
    return ("회사 인증 제공자에서 관리");
})()}><SettingsValue>{(function () {
    if (status.enrolled) {
        return ("켜짐");
    }
    return ("꺼짐");
})()}</SettingsValue></SettingsRow>
          <SettingsRow density="compact" title="복구 코드" description="안전한 장소에 별도 보관하세요."><SettingsValue>{(function () {
    if (status.enrolled) {
        return (`${status.recoveryCodesRemaining}개`);
    }
    return ("—");
})()}</SettingsValue></SettingsRow>
          <SettingsRow density="compact" title="보안 정책" description={(function () {
    if (status.restricted) {
        return ("설정 전까지 계정 접근이 제한됩니다.");
    }
    return ("현재 계정에 정상적으로 접근할 수 있습니다.");
})()}><SettingsValue>{(function () {
    if (status.required) {
        return ("필수");
    }
    return ("선택");
})()}</SettingsValue></SettingsRow>
        </SettingsGroup>
      ) : null}

      {status.required && !status.enrolled ? (
        <section className={styles.notice({ className: (function () {
    if (status.restricted) {
        return (styles.noticeDanger());
    }
    return (undefined);
})() })} role={(function () {
    if (status.restricted) {
        return ("alert");
    }
    return ("status");
})()}>
          <strong className={styles.noticeTitle()}>{(function () {
    if (status.restricted) {
        return ("계속하려면 인증 앱 설정이 필요합니다");
    }
    return ("인증 앱 설정 기한");
})()}</strong>
          <p className={styles.noticeDescription()}>{deadline?.toLocaleString("ko-KR") ?? "지금 설정하세요"}. 설정 중에도 프로젝트 데이터는 변경되지 않습니다.</p>
        </section>
      ) : null}

      {!status.localAccount ? (
        <section className={styles.card()}><h2>회사 인증 제공자에서 관리됨</h2><p>누리터 인증 앱은 로컬 비밀번호 계정에만 사용됩니다.</p></section>
      ) : null}

      {status.localAccount && !status.enrolled && enrollment === undefined && recoveryCodes === undefined ? (
        <section className={styles.card()}>
          <h2>인증 앱 설정</h2>
          <p>최근에 다시 인증한 세션이 필요합니다. 시작하면 완료되지 않은 기존 설정을 교체합니다.</p>
          <Button className={styles.cardAction()} size="sm" aria-label="인증 앱 설정 시작" variant="primary" disabled={isPending} onClick={begin}>설정 시작</Button>
        </section>
      ) : null}

      {enrollment !== undefined ? <MfaEnrollmentPanel enrollment={enrollment} pending={isPending} onSubmit={confirm} /> : null}

      {recoveryCodes !== undefined ? (
        <section className={styles.card({ className: styles.recovery() })} aria-labelledby="recovery-title">
          <h2 id="recovery-title">복구 코드 — 한 번만 표시됩니다</h2>
          <p>브라우저 밖의 안전한 장소에 보관하세요. 이 화면을 닫으면 다시 확인할 수 없습니다.</p>
          <ul className={styles.recoveryList()}>{recoveryCodes.map((code) => <li className={styles.recoveryItem()} key={code}><code className={styles.recoveryCode()}>{code}</code></li>)}</ul>
          <CheckboxField
            checked={copiedRecoveryCodes}
            label="모든 복구 코드를 안전한 곳에 저장했습니다"
            description="자동 복사, 직접 선택 또는 화면 인쇄 중 편한 방법으로 보관할 수 있습니다."
            onCheckedChange={setCopiedRecoveryCodes}
          />
          <div className={styles.actions()}>
            <Button size="sm" onClick={copyRecoveryCodes}>모든 코드 복사</Button>
            <Button size="sm" variant="primary" disabled={!copiedRecoveryCodes} onClick={finishRecoveryConfirmation}>
              {(function () {
    if (copiedRecoveryCodes) {
        return ("코드를 안전하게 저장했습니다");
    }
    return ("계속하려면 코드를 복사하세요");
})()}
            </Button>
          </div>
        </section>
      ) : null}

      {status.enrolled && recoveryCodes === undefined && !isSetupView ? (
        <div className={styles.grid()}>
          <CodePanel title="인증 앱 확인" description="새로운 6자리 코드를 입력해 현재 세션을 확인합니다." pending={isPending} onSubmit={(event) => submitCode(event, false)} />
          <CodePanel title="복구 코드 사용" description={`일회용 코드가 ${status.recoveryCodesRemaining}개 남았습니다. 복구 후 중요한 변경에는 다시 인증해야 합니다.`} pending={isPending} onSubmit={(event) => submitCode(event, true)} recovery />
          {(function () {
    if (!isChallengeView) {
        return (<section className={styles.card()}>
            <h2>다중 인증 해제</h2>
            <p>인스턴스 정책에서 다중 인증을 필수로 요구하지 않을 때만 해제할 수 있습니다.</p>
            <Button className={styles.cardAction()} size="sm" disabled={isPending || status.required} onClick={() => setConfirmingDisable(true)}>MFA 해제</Button>
          </section>);
    }
    return (null);
})()}
        </div>
      ) : null}

      {message ? <p className={styles.feedback({ className: (function () {
    if (message.tone === "error") {
        return (styles.feedbackError());
    }
    return (styles.feedbackSuccess());
})() })} role={(function () {
    if (message.tone === "error") {
        return ("alert");
    }
    return ("status");
})()}>{message.text}</p> : null}
      <div className={styles.safeNavigation()}>
        <Button size="sm" aria-label="로그아웃 또는 계정 전환" disabled={isPending} onClick={signOut}>로그아웃 또는 계정 전환</Button>
      </div>
      <ConfirmationDialog
        busy={isPending}
        confirmLabel={isPending ? "해제 중…" : "MFA 해제"}
        description="계정의 추가 인증 보호가 제거되고 다른 세션은 로그아웃됩니다. 다시 로그인할 수 있는지 확인하세요."
        open={confirmingDisable}
        title="다단계 인증을 해제할까요?"
        onCancel={() => setConfirmingDisable(false)}
        onConfirm={() => void disable()}
      />
    </main>
  );
}

function CodePanel({ title, description, pending, onSubmit, recovery = false }: { readonly title: string; readonly description: string; readonly pending: boolean; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void; readonly recovery?: boolean }) {
  const id = recovery ? "mfa-recovery-code" : "mfa-challenge-code";
  const styles = mfaSecurityStyles();
  return (
    <section className={styles.card()}>
      <h2>{title}</h2><p>{description}</p>
      <form className={styles.codeForm()} onSubmit={onSubmit} aria-busy={pending}>
        <label htmlFor={id}>{recovery ? "복구 코드" : "6자리 인증 코드"}</label>
        <Input id={id} name="code" size="sm" autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} minLength={6} maxLength={128} required />
        <Button type="submit" size="sm" variant="primary" disabled={pending}>{pending ? "확인 중…" : (function () {
    if (recovery) {
        return ("계정 복구");
    }
    return ("코드 확인");
})()}</Button>
      </form>
    </section>
  );
}
