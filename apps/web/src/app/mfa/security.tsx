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
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { FormEvent } from "react";

import { mfaSecurityStyles } from "#src/app/mfa/security.styles.ts";
import { Button } from "#src/components/ui/button.tsx";
import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { Input } from "#src/components/ui/input.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "#src/components/ui/settings-group.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

const MfaEnrollmentPanel = dynamic(
  () => import("#src/app/mfa/mfa-enrollment-panel.tsx").then((module) => module.MfaEnrollmentPanel),
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
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [enrollment, setEnrollment] = useState<MfaEnrollmentStart>();
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>();
  const [copiedRecoveryCodes, setCopiedRecoveryCodes] = useState(false);
  const [message, setMessage] = useState<{ readonly tone: "error" | "success"; readonly text: string }>();
  const [confirmingDisable, setConfirmingDisable] = useState(false);
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
        setMessage({ tone: "success", text: "인증 앱을 확인했습니다. 계속하기 전에 모든 복구 코드를 저장하세요." });
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
      setMessage({ tone: "success", text: "복구 코드를 복사했습니다. 계속하기 전에 안전한 곳에 보관하세요." });
    } catch {
      setMessage({ tone: "error", text: "브라우저가 자동 복사를 허용하지 않았습니다. 코드를 직접 선택해 안전한 곳에 저장한 뒤 아래 확인 항목을 선택하세요." });
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
            ? "계정을 복구했습니다. 다른 세션은 로그아웃되었으며 최근 재인증으로 처리되지는 않습니다."
            : "인증 앱 확인을 완료하고 세션을 새로 발급했습니다."
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
        setConfirmingDisable(false);
        setMessage({ tone: "success", text: "다단계 인증을 해제하고 다른 세션을 로그아웃했습니다." });
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
  const isSetupView = view === "setup";
  const isChallengeView = view === "challenge";
  const styles = mfaSecurityStyles({ standalone: view !== "security" });
  const securityHref = isSetupView ? "/mfa/setup" : isChallengeView ? "/mfa/challenge" : "/account/security";
  const pageTitle = isSetupView ? "다단계 인증 설정" : isChallengeView ? "다단계 인증 확인" : "계정 보안";
  const pageDescription = isSetupView
    ? `${displayName}님의 계정에 인증 앱을 연결하고 복구 코드를 보관합니다.`
    : isChallengeView
      ? "인증 앱의 새 코드 또는 사용하지 않은 복구 코드로 현재 세션을 확인합니다."
      : `${displayName}님의 로컬 계정을 인증 앱과 일회용 복구 코드로 보호합니다.`;
  return (
    <main id="main-content" className={styles.root()}>
      {view === "security" ? null : <nav className={styles.productBar()} aria-label="계정 보안 탐색">
        <Link className={styles.productBrand()} href={status.restricted ? "/mfa/setup" : "/workspaces"}><span className={styles.brandMark()} aria-hidden="true">N</span><strong>NURITEO</strong></Link>
        {status.restricted ? <span className={styles.productStatus()}>계정 보호 설정이 필요합니다</span> : <div className={styles.productNav()}><Link className={styles.productLink()} href="/workspaces">워크스페이스</Link><Link className={styles.productLink()} href="/account/identities">연결된 로그인</Link><Link className={styles.productLink()} aria-current="page" href={securityHref}>계정 보안</Link></div>}
      </nav>}
      <PageHeader density="compact" eyebrow="계정 / 보안" title={pageTitle} description={pageDescription} />

      {!isChallengeView ? (
        <SettingsGroup density="compact" title="보안 상태" description="현재 계정에 적용된 로그인 보호 상태입니다.">
          <SettingsRow density="compact" title="다중 인증" description={status.localAccount ? "인증 앱 기반" : "회사 인증 제공자에서 관리"}><SettingsValue>{status.enrolled ? "켜짐" : "꺼짐"}</SettingsValue></SettingsRow>
          <SettingsRow density="compact" title="복구 코드" description="안전한 장소에 별도 보관하세요."><SettingsValue>{status.enrolled ? `${status.recoveryCodesRemaining}개` : "—"}</SettingsValue></SettingsRow>
          <SettingsRow density="compact" title="보안 정책" description={status.restricted ? "설정 전까지 계정 접근이 제한됩니다." : "현재 계정에 정상적으로 접근할 수 있습니다."}><SettingsValue>{status.required ? "필수" : "선택"}</SettingsValue></SettingsRow>
        </SettingsGroup>
      ) : null}

      {status.required && !status.enrolled ? (
        <section className={styles.notice({ className: status.restricted ? styles.noticeDanger() : undefined })} role={status.restricted ? "alert" : "status"}>
          <strong className={styles.noticeTitle()}>{status.restricted ? "계속하려면 인증 앱 설정이 필요합니다" : "인증 앱 설정 기한"}</strong>
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
          <Button className={styles.cardAction()} size="sm" aria-label="인증 앱 설정 시작" variant="primary" disabled={mutation.isPending} onClick={begin}>설정 시작</Button>
        </section>
      ) : null}

      {enrollment !== undefined ? <MfaEnrollmentPanel enrollment={enrollment} pending={mutation.isPending} onSubmit={confirm} /> : null}

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
              {copiedRecoveryCodes ? "코드를 안전하게 저장했습니다" : "계속하려면 코드를 복사하세요"}
            </Button>
          </div>
        </section>
      ) : null}

      {status.enrolled && recoveryCodes === undefined && !isSetupView ? (
        <div className={styles.grid()}>
          <CodePanel title="인증 앱 확인" description="새로운 6자리 코드를 입력해 현재 세션을 확인합니다." pending={mutation.isPending} onSubmit={(event) => submitCode(event, false)} />
          <CodePanel title="복구 코드 사용" description={`일회용 코드가 ${status.recoveryCodesRemaining}개 남았습니다. 복구 후 중요한 변경에는 다시 인증해야 합니다.`} pending={mutation.isPending} onSubmit={(event) => submitCode(event, true)} recovery />
          {!isChallengeView ? <section className={styles.card()}>
            <h2>다중 인증 해제</h2>
            <p>인스턴스 정책에서 다중 인증을 필수로 요구하지 않을 때만 해제할 수 있습니다.</p>
            <Button className={styles.cardAction()} size="sm" disabled={mutation.isPending || status.required} onClick={() => setConfirmingDisable(true)}>MFA 해제</Button>
          </section> : null}
        </div>
      ) : null}

      {message ? <p className={styles.feedback({ className: message.tone === "error" ? styles.feedbackError() : styles.feedbackSuccess() })} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p> : null}
      <div className={styles.safeNavigation()}>
        <Button size="sm" aria-label="로그아웃 또는 계정 전환" disabled={mutation.isPending} onClick={signOut}>로그아웃 또는 계정 전환</Button>
      </div>
      <ConfirmationDialog
        busy={mutation.isPending}
        confirmLabel={mutation.isPending ? "해제 중…" : "MFA 해제"}
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
        <Button type="submit" size="sm" variant="primary" disabled={pending}>{pending ? "확인 중…" : recovery ? "계정 복구" : "코드 확인"}</Button>
      </form>
    </section>
  );
}

function mfaFailure(error: unknown): { readonly tone: "error"; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { tone: "error", text: "서버에 보안 변경이 반영되었을 수 있습니다. 같은 작업을 다시 시도해 보호된 일회성 응답을 복구하세요." };
  if (error instanceof ApiError && error.status === 403) return { tone: "error", text: "최근 재인증 또는 관리자 정책 승인이 필요합니다." };
  if (error instanceof ApiError && error.status === 401) return { tone: "error", text: "코드가 일치하지 않습니다. 새 코드를 기다리거나 사용하지 않은 복구 코드를 입력하세요." };
  if (error instanceof ApiError && (error.status === 409 || error.status === 412)) return { tone: "error", text: "다른 곳에서 MFA 상태가 변경되었습니다. 새로 고친 뒤 다시 시도하세요." };
  return { tone: "error", text: "보안 변경을 안전하게 완료하지 못했습니다. 노출된 정보는 없으며 잠시 후 다시 시도해 주세요." };
}
