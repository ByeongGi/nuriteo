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

import { Button } from "#src/components/ui/button.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

const MfaEnrollmentPanel = dynamic(
  () => import("#src/app/mfa/mfa-enrollment-panel.tsx").then((module) => module.MfaEnrollmentPanel),
  {
    loading: () => <section className="mfa-card" aria-busy="true"><h2>인증 앱 설정을 준비하는 중입니다…</h2></section>,
    ssr: false
  }
);

export function MfaSecurity({ status, displayName }: { readonly status: MfaStatus; readonly displayName: string }) {
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
      setMessage({ tone: "error", text: "브라우저에서 코드를 복사하지 못했습니다. 이 화면을 유지하고 클립보드 접근을 허용한 뒤 다시 시도하세요." });
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
  return (
    <main id="main-content" className="workspace-page mfa-page">
      <nav className="mfa-product-bar" aria-label="계정 보안 탐색">
        <Link className="mfa-product-bar__brand" href={status.restricted ? "/mfa" : "/workspaces"}><span aria-hidden="true">N</span><strong>NURITEO</strong></Link>
        {status.restricted ? <span>계정 보호 설정이 필요합니다</span> : <div><Link href="/workspaces">워크스페이스</Link><Link href="/identities">연결된 계정</Link><Link aria-current="page" href="/mfa">계정 보안</Link></div>}
      </nav>
      <header className="workspace-page__intro">
        <p className="eyebrow">계정 / 보안</p>
        <h1 aria-label="다단계 인증">계정 보안</h1>
        <p>{displayName}님의 로컬 계정을 인증 앱과 일회용 복구 코드로 보호합니다.</p>
      </header>

      <section className="product-metrics" aria-label="계정 보안 요약">
        <article><span>다중 인증</span><strong>{status.enrolled ? "켜짐" : "꺼짐"}</strong><small>{status.localAccount ? "인증 앱 기반" : "회사 인증 제공자에서 관리"}</small></article>
        <article><span>복구 코드</span><strong>{status.enrolled ? `${status.recoveryCodesRemaining}개` : "—"}</strong><small>안전한 장소에 별도 보관</small></article>
        <article><span>보안 정책</span><strong>{status.required ? "필수" : "선택"}</strong><small>{status.restricted ? "설정 전까지 접근 제한" : "현재 계정 접근 가능"}</small></article>
      </section>

      {status.required && !status.enrolled ? (
        <section className={`mfa-notice ${status.restricted ? "mfa-notice--danger" : ""}`} role={status.restricted ? "alert" : "status"}>
          <strong>{status.restricted ? "계속하려면 인증 앱 설정이 필요합니다" : "인증 앱 설정 기한"}</strong>
          <p>{deadline?.toLocaleString("ko-KR") ?? "지금 설정하세요"}. 설정 중에도 프로젝트 데이터는 변경되지 않습니다.</p>
        </section>
      ) : null}

      {!status.localAccount ? (
        <section className="mfa-card"><h2>회사 인증 제공자에서 관리됨</h2><p>누리터 인증 앱은 로컬 비밀번호 계정에만 사용됩니다.</p></section>
      ) : null}

      {status.localAccount && !status.enrolled && enrollment === undefined && recoveryCodes === undefined ? (
        <section className="mfa-card">
          <h2>인증 앱 설정</h2>
          <p>최근에 다시 인증한 세션이 필요합니다. 시작하면 완료되지 않은 기존 설정을 교체합니다.</p>
          <Button aria-label="인증 앱 설정 시작" variant="primary" disabled={mutation.isPending} onClick={begin}>설정 시작</Button>
        </section>
      ) : null}

      {enrollment !== undefined ? <MfaEnrollmentPanel enrollment={enrollment} pending={mutation.isPending} onSubmit={confirm} /> : null}

      {recoveryCodes !== undefined ? (
        <section className="mfa-card mfa-recovery" aria-labelledby="recovery-title">
          <h2 id="recovery-title">복구 코드 — 한 번만 표시됩니다</h2>
          <p>브라우저 밖의 안전한 장소에 보관하세요. 이 화면을 닫으면 다시 확인할 수 없습니다.</p>
          <ul>{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
          <div className="mfa-actions">
            <Button onClick={copyRecoveryCodes}>모든 코드 복사</Button>
            <Button variant="primary" disabled={!copiedRecoveryCodes} onClick={finishRecoveryConfirmation}>
              {copiedRecoveryCodes ? "코드를 안전하게 저장했습니다" : "계속하려면 코드를 복사하세요"}
            </Button>
          </div>
        </section>
      ) : null}

      {status.enrolled && recoveryCodes === undefined ? (
        <div className="mfa-grid">
          <CodePanel title="인증 앱 확인" description="새로운 6자리 코드를 입력해 현재 세션을 확인합니다." pending={mutation.isPending} onSubmit={(event) => submitCode(event, false)} />
          <CodePanel title="복구 코드 사용" description={`일회용 코드가 ${status.recoveryCodesRemaining}개 남았습니다. 복구 후 중요한 변경에는 다시 인증해야 합니다.`} pending={mutation.isPending} onSubmit={(event) => submitCode(event, true)} recovery />
          <section className="mfa-card">
            <h2>다중 인증 해제</h2>
            <p>인스턴스 정책에서 다중 인증을 필수로 요구하지 않을 때만 해제할 수 있습니다.</p>
            <Button disabled={mutation.isPending || status.required} onClick={() => setConfirmingDisable(true)}>MFA 해제</Button>
          </section>
        </div>
      ) : null}

      {message ? <p className={`mfa-feedback mfa-feedback--${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p> : null}
      <nav className="mfa-safe-navigation" aria-label="제한된 계정 작업">
        {!status.restricted ? <Link href="/workspaces">워크스페이스로 돌아가기</Link> : null}
        <Button aria-label="로그아웃 또는 계정 전환" disabled={mutation.isPending} onClick={signOut}>로그아웃 또는 계정 전환</Button>
      </nav>
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
  return (
    <section className="mfa-card">
      <h2>{title}</h2><p>{description}</p>
      <form className="mfa-code-form" onSubmit={onSubmit} aria-busy={pending}>
        <label htmlFor={id}>{recovery ? "복구 코드" : "6자리 인증 코드"}</label>
        <input id={id} name="code" autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} minLength={6} maxLength={128} required />
        <Button type="submit" disabled={pending}>{pending ? "확인 중…" : recovery ? "계정 복구" : "코드 확인"}</Button>
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
